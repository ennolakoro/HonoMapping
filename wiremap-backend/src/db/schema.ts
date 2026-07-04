import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

// --- Better Auth Standard Tables ---
export const user = sqliteTable("user", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: integer("emailVerified", { mode: "boolean" }).notNull(),
	image: text("image"),
	createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
	updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull()
});

export const session = sqliteTable("session", {
	id: text("id").primaryKey(),
	expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
	token: text("token").notNull().unique(),
	createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
	updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
	ipAddress: text("ipAddress"),
	userAgent: text("userAgent"),
	userId: text("userId").notNull().references(() => user.id)
});

export const account = sqliteTable("account", {
	id: text("id").primaryKey(),
	accountId: text("accountId").notNull(),
	providerId: text("providerId").notNull(),
	userId: text("userId").notNull().references(() => user.id),
	accessToken: text("accessToken"),
	refreshToken: text("refreshToken"),
	idToken: text("idToken"),
	accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp" }),
	refreshTokenExpiresAt: integer("refreshTokenExpiresAt", { mode: "timestamp" }),
	scope: text("scope"),
	password: text("password"),
	createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
	updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull()
});

// --- WireMap GIS Tables ---
export const devices = sqliteTable("devices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(), // 'MIKROTIK', 'OLT', 'ODC', 'ODP'
  name: text("name").notNull(),
  parentId: integer("parent_id"), // self-referencing
  lat: real("lat"),
  lng: real("lng"),
  capacity: integer("capacity"), // For ODC
  portsCount: integer("ports_count"), // For ODP
  cablePath: text("cable_path")
});

export const clients = sqliteTable("clients", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  phone: text("phone"),
  odpId: integer("odp_id").references(() => devices.id),
  odpPort: integer("odp_port"),
  lat: real("lat"),
  lng: real("lng"),
  pppoeUsername: text("pppoe_username"),
  snModem: text("sn_modem"),
  wifiSsid: text("wifi_ssid"),
  wifiPassword: text("wifi_password"),
  wifiSsid5g: text("wifi_ssid_5g"),
  wifiPassword5g: text("wifi_password_5g"),
  lanStatus: text("lan_status"),
  associatedDevices: integer("associated_devices"),
  connectedHosts: text("connected_hosts"),
  brand: text("brand"),
  modelName: text("model_name"),
  hardwareVersion: text("hardware_version"),
  softwareVersion: text("software_version"),
  macAddress: text("mac_address"),
  wanIp: text("wan_ip"),
  txPower: text("tx_power"),
  temperature: text("temperature"),
  voltage: text("voltage"),
  rxPower: text("rx_power"),
  isOnline: integer("is_online", { mode: "boolean" }).default(false),
  offlineReason: text("offline_reason"),
  cablePath: text("cable_path"),
  // Tipe client: 'PPPOE' | 'HOTSPOT' | 'UNKNOWN'
  // PPPOE  = terdeteksi via /ppp/active Mikrotik
  // HOTSPOT = terdeteksi via DHCP lease, tidak ada PPPoE user
  clientType: text("client_type").default('PPPOE'),
  // IP LAN dari DHCP lease (untuk modem HOTSPOT)
  lanIp: text("lan_ip"),
  // URL Connection Request CWMP dari Inform modem (untuk direct HTTP trigger)
  connectionRequestUrl: text("connection_request_url"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull()
});
