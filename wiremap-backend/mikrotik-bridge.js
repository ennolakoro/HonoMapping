const express = require('express');
const { RouterOSClient } = require('routeros-client');
const cors = require('cors');
require('dotenv').config({ path: './.dev.vars' });

const app = express();
app.use(cors());
app.use(express.json());

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
        const client = await api.connect();
        
        // Ambil daftar PPPoE Active
        const pppoeActive = await client.menu('/ppp/active').get();
        
        api.close();
        
        // Format agar sesuai dengan struktur yang diharapkan oleh aplikasi kita
        const formatted = pppoeActive.map(item => ({
            name: item.name,
            address: item.address,
            uptime: item.uptime,
            service: item.service,
            'caller-id': item['caller-id'] || item.callerId || item.macAddress || item.mac || ''
        }));

        console.log(`Berhasil mendapatkan ${formatted.length} client aktif.`);
        res.json(formatted);
    } catch (err) {
        console.error('Gagal menghubungi Mikrotik:', err);
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
        const client = await api.connect();
        const secrets = await client.menu('/ppp/secret').get();
        api.close();

        const formatted = secrets.map(item => ({
            name: item.name || '',
            password: item.password || '',
            service: item.service || '',
            profile: item.profile || '',
            disabled: item.disabled || 'false',
            comment: item.comment || ''
        }));

        res.json(formatted);
    } catch (err) {
        console.error('Gagal mengambil PPP secret:', err);
        res.status(502).json({ error: 'Gagal mengambil PPP secret', details: err.message });
    }
});

// Endpoint untuk trigger modem CWMP (Mini ACS)
app.post('/trigger-modem', async (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: 'IP Modem tidak diberikan' });

    const { host, port } = getMikrotikHostInfo();
    const user = process.env.MIKROTIK_USER;
    const password = process.env.MIKROTIK_PASS;

    res.status(202).json({ success: true, queued: true, message: `Trigger modem ${ip} masuk antrian bridge` });

    setImmediate(async () => {
        const api = createRouterClient();
        api.on('error', (err) => console.log('RouterOS Error:', err.message));

        try {
            console.log(`Men-trigger modem ${ip} via Mikrotik API background...`);
            const client = await withTimeout(
                api.connect(),
                35000,
                `Timeout koneksi Mikrotik ${host}:${port} saat trigger modem ${ip}`
            );

            const modemUrl = `http://${ip}:7547/`;
            const modemUser = process.env.MODEM_CWMP_USER || 'admin';
            const modemPass = process.env.MODEM_CWMP_PASS || 'admin';

            await withTimeout(
                client.menu('/tool/fetch').exec({
                    url: modemUrl,
                    user: modemUser,
                    password: modemPass,
                    "keep-result": "no"
                }),
                12000,
                `Timeout /tool fetch ke ${ip}:7547`
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
        const client = await api.connect();

        // Ambil semua DHCP lease dari semua DHCP server
        const leases = await client.menu('/ip/dhcp-server/lease').get();

        api.close();

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
        res.json(active);
    } catch (err) {
        console.error('Gagal mengambil DHCP lease dari Mikrotik:', err);
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
