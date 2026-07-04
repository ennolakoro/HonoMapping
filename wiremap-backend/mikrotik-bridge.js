const express = require('express');
const { RouterOSClient } = require('routeros-client');
const cors = require('cors');
require('dotenv').config({ path: './.dev.vars' });

const app = express();
app.use(cors());
app.use(express.json());

let activeCache = null;
let dhcpCache = null;
let secretCache = null;
const QUERY_TIMEOUT_MS = parseInt(process.env.MIKROTIK_QUERY_TIMEOUT_MS || '35000', 10);

// Helper function to extract IP and Port from MIKROTIK_IP
function getMikrotikHostInfo() {
    const rawIp = process.env.MIKROTIK_IP || '';
    const parts = rawIp.split(':');
    return {
        host: parts[0] || '',
        port: parts.length > 1 ? parseInt(parts[1], 10) : 8728
    };
}

function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createRouterClient() {
    const { host, port } = getMikrotikHostInfo();
    return new RouterOSClient({
        host,
        user: process.env.MIKROTIK_USER,
        password: process.env.MIKROTIK_PASS,
        port,
        timeout: parseInt(process.env.MIKROTIK_API_TIMEOUT || '30', 10)
    });
}

app.get('/active', async (req, res) => {
    const { host, port } = getMikrotikHostInfo();
    const user = process.env.MIKROTIK_USER;
    const password = process.env.MIKROTIK_PASS;

    if (!host || !user || !password) {
        return res.status(500).json({ error: 'Kredensial Mikrotik di .dev.vars tidak lengkap' });
    }

    const api = createRouterClient();

    api.on('error', (err) => {
        console.log('RouterOS Error:', err.message);
    });

    try {
        console.log(`Menghubungi Mikrotik API Lama di ${host}:${port}...`);
        const client = await withTimeout(
            api.connect(),
            QUERY_TIMEOUT_MS,
            `Timeout koneksi Mikrotik ${host}:${port} saat membaca PPPoE active`
        );
        
        // Ambil daftar PPPoE Active
        const pppoeActive = await withTimeout(
            client.menu('/ppp/active').get(),
            QUERY_TIMEOUT_MS,
            'Timeout membaca /ppp/active dari Mikrotik'
        );
        
        await api.close().catch(() => {});
        
        // Format agar sesuai dengan struktur yang diharapkan oleh aplikasi kita
        const formatted = pppoeActive.map(item => ({
            name: item.name,
            address: item.address,
            uptime: item.uptime,
            service: item.service,
            'caller-id': item['caller-id'] || item.callerId || item.macAddress || item.mac || ''
        }));

        console.log(`Berhasil mendapatkan ${formatted.length} client aktif.`);
        activeCache = { data: formatted, updatedAt: Date.now() };
        res.json(formatted);
    } catch (err) {
        console.error('Gagal menghubungi Mikrotik:', err);
        await api.close().catch(() => {});
        if (activeCache) {
            console.warn(`Menggunakan cache PPPoE active (${activeCache.data.length} record). Umur cache ${Math.round((Date.now() - activeCache.updatedAt) / 1000)} detik.`);
            res.set('X-Bridge-Cache', 'stale');
            return res.json(activeCache.data);
        }
        res.status(502).json({ error: 'Gagal menghubungi Mikrotik API Lama', details: err.message });
    }
});

app.get('/ppp-secrets', async (req, res) => {
    const { host, port } = getMikrotikHostInfo();
    const user = process.env.MIKROTIK_USER;
    const password = process.env.MIKROTIK_PASS;

    if (!host || !user || !password) {
        return res.status(500).json({ error: 'Kredensial Mikrotik di .dev.vars tidak lengkap' });
    }

    const api = createRouterClient();
    api.on('error', (err) => console.log('RouterOS Error:', err.message));

    try {
        console.log(`Mengambil PPP secret dari Mikrotik ${host}:${port}...`);
        const client = await withTimeout(
            api.connect(),
            QUERY_TIMEOUT_MS,
            `Timeout koneksi Mikrotik ${host}:${port} saat membaca PPP secret`
        );
        const secrets = await withTimeout(
            client.menu('/ppp/secret').get(),
            QUERY_TIMEOUT_MS,
            'Timeout membaca /ppp/secret dari Mikrotik'
        );
        await api.close().catch(() => {});

        const formatted = secrets.map(item => ({
            name: item.name || '',
            password: item.password || '',
            service: item.service || '',
            profile: item.profile || '',
            disabled: item.disabled || 'false',
            comment: item.comment || ''
        }));

        secretCache = { data: formatted, updatedAt: Date.now() };
        res.json(formatted);
    } catch (err) {
        console.error('Gagal mengambil PPP secret:', err);
        await api.close().catch(() => {});
        if (secretCache) {
            console.warn(`Menggunakan cache PPP secret (${secretCache.data.length} record). Umur cache ${Math.round((Date.now() - secretCache.updatedAt) / 1000)} detik.`);
            res.set('X-Bridge-Cache', 'stale');
            return res.json(secretCache.data);
        }
        res.status(502).json({ error: 'Gagal mengambil PPP secret', details: err.message });
    }
});

// Endpoint untuk trigger modem CWMP (Mini ACS)
app.post('/trigger-modem', async (req, res) => {
    const { ip, connectionRequestUrl, cwmpUser, cwmpPass } = req.body;
    if (!ip) return res.status(400).json({ error: 'IP Modem tidak diberikan' });

    const { host, port } = getMikrotikHostInfo();

    res.status(202).json({ success: true, queued: true, message: `Trigger modem ${ip} masuk antrian bridge` });

    setImmediate(async () => {
        // --- Metode 1: Direct HTTP ke Connection Request URL modem ---
        // Ini lebih reliable karena tidak perlu lewat Mikrotik
        const crUrl = connectionRequestUrl || `http://${ip}:7547/`;
        const modemUser = cwmpUser || process.env.MODEM_CWMP_USER || 'admin';
        const modemPass = cwmpPass || process.env.MODEM_CWMP_PASS || 'admin';

        console.log(`[TRIGGER] Mencoba direct HTTP ke ${crUrl} ...`);
        const credentials = Buffer.from(`${modemUser}:${modemPass}`).toString('base64');
        try {
            const directRes = await Promise.race([
                fetch(crUrl, {
                    method: 'GET',
                    headers: { 'Authorization': `Basic ${credentials}` }
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
            ]);
            console.log(`[TRIGGER] Direct HTTP ke ${crUrl} berhasil, status: ${directRes.status}`);
            return; // Berhasil, tidak perlu Mikrotik
        } catch (err) {
            console.warn(`[TRIGGER] Direct HTTP gagal (${err.message}), mencoba via Mikrotik /tool/fetch...`);
        }

        // --- Metode 2: Via Mikrotik /tool/fetch (RouterOS v6 kompatibel) ---
        const api = createRouterClient();
        api.on('error', (err) => console.log('RouterOS Error:', err.message));

        try {
            console.log(`[TRIGGER] Men-trigger modem ${ip} via Mikrotik API background...`);
            const client = await withTimeout(
                api.connect(),
                35000,
                `Timeout koneksi Mikrotik ${host}:${port} saat trigger modem ${ip}`
            );

            const modemUrl = crUrl;

            // RouterOS v6: gunakan 'output' bukan 'keep-result'
            await withTimeout(
                client.menu('/tool/fetch').exec({
                    url: modemUrl,
                    user: modemUser,
                    password: modemPass,
                    output: 'none'
                }),
                12000,
                `Timeout /tool fetch ke ${modemUrl}`
            ).catch((err) => {
                // Banyak modem hanya perlu dipoke; fetch bisa timeout walau request sudah terkirim.
                console.warn(`Trigger modem ${ip} selesai dengan warning: ${err.message}`);
            });

            await api.close().catch(() => {});
            console.log(`Trigger modem ${ip} selesai diproses bridge.`);
        } catch (err) {
            console.error(`Gagal trigger modem background ${ip}:`, err);
            await api.close().catch(() => {});
        }
    });
});

// Endpoint untuk mengambil semua DHCP Lease aktif dari Mikrotik
// Digunakan backend untuk mendeteksi modem yang tidak punya PPPoE (tipe HOTSPOT)
// Logika klasifikasi: MAC ada di PPPoE active = PPPoE, tidak ada = HOTSPOT
app.get('/dhcp-leases', async (req, res) => {
    const { host, port } = getMikrotikHostInfo();
    const user = process.env.MIKROTIK_USER;
    const password = process.env.MIKROTIK_PASS;

    if (!host || !user || !password) {
        return res.status(500).json({ error: 'Kredensial Mikrotik di .dev.vars tidak lengkap' });
    }

    const api = createRouterClient();
    api.on('error', (err) => console.log('RouterOS Error:', err.message));

    try {
        console.log(`Mengambil DHCP lease dari Mikrotik ${host}:${port}...`);
        const client = await withTimeout(
            api.connect(),
            QUERY_TIMEOUT_MS,
            `Timeout koneksi Mikrotik ${host}:${port} saat membaca DHCP lease`
        );

        // Ambil semua DHCP lease dari semua DHCP server
        const leases = await withTimeout(
            client.menu('/ip/dhcp-server/lease').get(),
            QUERY_TIMEOUT_MS,
            'Timeout membaca /ip/dhcp-server/lease dari Mikrotik'
        );

        await api.close().catch(() => {});

        // Format field agar konsisten dengan yang diharapkan backend
        const formatted = leases.map(lease => ({
            address:       lease.address || '',
            'mac-address': lease['mac-address'] || lease.macAddress || '',
            server:        lease.server || '',
            'host-name':   lease['host-name'] || lease.hostName || '',
            status:        lease.status || '',
            comment:       lease.comment || ''
        }));

        // Hanya kirim yang aktif (status = 'bound')
        const active = formatted.filter(l => l.status === 'bound');
        console.log(`Berhasil mendapatkan ${active.length} DHCP lease aktif dari total ${formatted.length}.`);
        dhcpCache = { data: active, updatedAt: Date.now() };
        res.json(active);
    } catch (err) {
        console.error('Gagal mengambil DHCP lease dari Mikrotik:', err);
        await api.close().catch(() => {});
        if (dhcpCache) {
            console.warn(`Menggunakan cache DHCP lease (${dhcpCache.data.length} record). Umur cache ${Math.round((Date.now() - dhcpCache.updatedAt) / 1000)} detik.`);
            res.set('X-Bridge-Cache', 'stale');
            return res.json(dhcpCache.data);
        }
        res.status(502).json({ error: 'Gagal mengambil DHCP lease', details: err.message });
    }
});

const PORT = 3005;
app.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(`🚀 Mikrotik V6 Bridge API berjalan di port ${PORT}`);
    console.log(`Jembatan ini akan menerjemahkan API lama (8728/2001)`);
    console.log(`menjadi REST API untuk Peta GIS Anda.`);
    console.log(`=================================================`);
});
