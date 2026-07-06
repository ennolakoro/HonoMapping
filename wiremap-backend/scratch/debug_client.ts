import { getDb } from '../src/db';
import { clients } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

async function run() {
  const db = getDb({
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN
  });

  const targetSn = '485754437DF062B3';
  console.log(`Mencari data untuk SN: ${targetSn}`);
  
  const results = await db.select().from(clients).where(eq(clients.snModem, targetSn)).limit(1);
  if (results.length === 0) {
    console.log("Client tidak ditemukan.");
    return;
  }

  const client = results[0];
  console.log("=== CLIENT METADATA ===");
  console.log("ID:", client.id);
  console.log("Name:", client.name);
  console.log("Lan IP:", client.lanIp);
  console.log("Online:", client.isOnline);
  console.log("Rx Power:", client.rxPower);
  console.log("Tx Power:", client.txPower);
  console.log("WAN IP:", client.wanIp);
  
  console.log("\n=== PARAMETER LIST JSON ===");
  if (client.parameterListJson) {
    const list = JSON.parse(client.parameterListJson);
    console.log(`Total parameter: ${list.length}`);
    console.log(JSON.stringify(list.slice(0, 30), null, 2));
    console.log("...");
    console.log("Mencari WLAN di list:");
    console.log(list.filter((p: string) => p.toLowerCase().includes('wlan') || p.toLowerCase().includes('wifi')));
    console.log("Mencari WAN di list:");
    console.log(list.filter((p: string) => p.toLowerCase().includes('wan') || p.toLowerCase().includes('ppp')));
  } else {
    console.log("parameterListJson KOSONG (null)");
  }

  console.log("\n=== RAW MODEM PARAMS JSON ===");
  if (client.rawModemParamsJson) {
    const raw = JSON.parse(client.rawModemParamsJson);
    console.log("Jumlah key:", Object.keys(raw).length);
    console.log("Contoh key-value:");
    for (const [k, v] of Object.entries(raw)) {
      if (k.toLowerCase().includes('wlan') || k.toLowerCase().includes('ssid') || k.toLowerCase().includes('key') || k.toLowerCase().includes('pass') || k.toLowerCase().includes('wan') || k.toLowerCase().includes('ip')) {
        console.log(`  ${k} => ${v}`);
      }
    }
  } else {
    console.log("rawModemParamsJson KOSONG (null)");
  }
}

run().catch(console.error);
