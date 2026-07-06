import { createClient } from '@libsql/client';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  console.error("TURSO_DATABASE_URL is missing!");
  process.exit(1);
}

const client = createClient({ url, authToken });

async function run() {
  const targetSn = '485754437DF062B3';
  console.log(`Mencari data di DB untuk SN: ${targetSn}`);
  
  const rs = await client.execute({
    sql: "SELECT id, name, lan_ip, rx_power, parameter_list_json, raw_modem_params_json FROM clients WHERE sn_modem = ?",
    args: [targetSn]
  });

  if (rs.rows.length === 0) {
    console.log("Client tidak ditemukan.");
    return;
  }

  const row = rs.rows[0];
  console.log("=== METADATA CLIENT ===");
  console.log("ID:", row.id);
  console.log("Nama:", row.name);
  console.log("Lan IP:", row.lan_ip);
  console.log("Rx Power:", row.rx_power);

  console.log("\n=== PARAMETER LIST ===");
  if (row.parameter_list_json) {
    const list = JSON.parse(row.parameter_list_json);
    console.log(`Total parameter: ${list.length}`);
    console.log("WLAN/SSID/Pass di list:");
    console.log(list.filter((p) => p.toLowerCase().includes('wlan') || p.toLowerCase().includes('wifi') || p.toLowerCase().includes('ssid') || p.toLowerCase().includes('key') || p.toLowerCase().includes('passphrase')));
    console.log("WAN di list:");
    console.log(list.filter((p) => p.toLowerCase().includes('wan') || p.toLowerCase().includes('ppp')));
  } else {
    console.log("parameterListJson KOSONG");
  }

  console.log("\n=== RAW MODEM PARAMS ===");
  if (row.raw_modem_params_json) {
    const raw = JSON.parse(row.raw_modem_params_json);
    console.log("Jumlah keys:", Object.keys(raw).length);
    for (const [k, v] of Object.entries(raw)) {
      const kl = k.toLowerCase();
      if (kl.includes('wlan') || kl.includes('ssid') || kl.includes('pass') || kl.includes('key') || kl.includes('wan') || kl.includes('ip')) {
        console.log(`  ${k} => ${v}`);
      }
    }
  } else {
    console.log("rawModemParamsJson KOSONG");
  }
}

run().catch(console.error).finally(() => client.close());
