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

app.get('/active', async (req, res) => {
    const { host, port } = getMikrotikHostInfo();
    const user = process.env.MIKROTIK_USER;
    const password = process.env.MIKROTIK_PASS;

    if (!host || !user || !password) {
        return res.status(500).json({ error: 'Kredensial Mikrotik di .dev.vars tidak lengkap' });
    }

    const api = new RouterOSClient({
        host: host,
        user: user,
        password: password,
        port: port
    });

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
            service: item.service
        }));

        console.log(`Berhasil mendapatkan ${formatted.length} client aktif.`);
        res.json(formatted);
    } catch (err) {
        console.error('Gagal menghubungi Mikrotik:', err);
        res.status(502).json({ error: 'Gagal menghubungi Mikrotik API Lama', details: err.message });
    }
});

// Endpoint untuk trigger modem CWMP (Mini ACS)
app.post('/trigger-modem', async (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: 'IP Modem tidak diberikan' });

    const { host, port } = getMikrotikHostInfo();
    const user = process.env.MIKROTIK_USER;
    const password = process.env.MIKROTIK_PASS;

    const api = new RouterOSClient({ host, user, password, port });
    api.on('error', (err) => console.log('RouterOS Error:', err.message));

    try {
        console.log(`Men-trigger modem ${ip} via Mikrotik API...`);
        const client = await api.connect();
        
        // Eksekusi /tool/fetch untuk mencolek modem beserta Autentikasi
        const modemUrl = `http://${ip}:7547/`;
        const modemUser = process.env.MODEM_CWMP_USER || 'admin';
        const modemPass = process.env.MODEM_CWMP_PASS || 'admin';
        
        // Catatan: exec mengembalikan promise yang jalan di background. 
        client.menu('/tool/fetch').exec({
            url: modemUrl,
            user: modemUser,
            password: modemPass,
            "keep-result": "no"
        }).then(() => {}).catch(() => {});
        
        // Beri waktu sejenak agar request terkirim
        await new Promise(resolve => setTimeout(resolve, 500));
        
        api.close();
        res.json({ success: true, message: `Berhasil men-trigger modem ${ip}` });
    } catch (err) {
        console.error('Gagal trigger modem:', err);
        res.status(502).json({ error: 'Gagal trigger modem via Mikrotik API', details: err.message });
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
