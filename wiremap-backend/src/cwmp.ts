/**
 * Helper untuk Mini ACS (TR-069 / CWMP)
 * Menggunakan Regex sederhana untuk mengekstrak data penting tanpa menginstal parser XML yang berat.
 */

// Format response untuk menjawab Inform dari modem dengan menyamakan ID transaksi dan Namespace
export function createInformResponse(cwmpId: string = '', cwmpNamespace: string = 'urn:dslforum-org:cwmp-1-0') {
  const headerXml = cwmpId 
    ? `<soap-env:Header><cwmp:ID soap-env:mustUnderstand="1">${cwmpId}</cwmp:ID></soap-env:Header>`
    : '<soap-env:Header/>';

  return `<?xml version="1.0" encoding="UTF-8"?>
<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="${cwmpNamespace}">
  ${headerXml}
  <soap-env:Body>
    <cwmp:InformResponse>
      <MaxEnvelopes>1</MaxEnvelopes>
    </cwmp:InformResponse>
  </soap-env:Body>
</soap-env:Envelope>`;
}

export function createGetParameterValues(cwmpId: string = '99999', cwmpNamespace: string = 'urn:dslforum-org:cwmp-1-0', params: string[] = []) {
  const paramsXml = params.map(p => `        <string>${p}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="${cwmpNamespace}">
  <soap-env:Header>
    <cwmp:ID soap-env:mustUnderstand="1">${cwmpId}</cwmp:ID>
  </soap-env:Header>
  <soap-env:Body>
    <cwmp:GetParameterValues>
      <ParameterNames soap-env:arrayType="xsd:string[${params.length}]">
${paramsXml}
      </ParameterNames>
    </cwmp:GetParameterValues>
  </soap-env:Body>
</soap-env:Envelope>`;
}

// Kirim GetParameterNames untuk menemukan semua nama parameter yang didukung modem
export function createGetParameterNames(
  cwmpId: string = '99998',
  cwmpNamespace: string = 'urn:dslforum-org:cwmp-1-0',
  paramPath: string = 'InternetGatewayDevice.LANDevice.1.Hosts.',
  nextLevel: boolean = false
) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="${cwmpNamespace}">
  <soap-env:Header>
    <cwmp:ID soap-env:mustUnderstand="1">${cwmpId}</cwmp:ID>
  </soap-env:Header>
  <soap-env:Body>
    <cwmp:GetParameterNames>
      <ParameterPath>${paramPath}</ParameterPath>
      <NextLevel>${nextLevel ? 'true' : 'false'}</NextLevel>
    </cwmp:GetParameterNames>
  </soap-env:Body>
</soap-env:Envelope>`;
}

const uniqueParams = (params: string[]) => [...new Set(params)]

const buildIgdWanParams = () => {
  const params: string[] = []
  const fields = [
    'Name',
    'Username',
    'Password',
    'NATEnabled',
    'Enable',
    'ConnectionStatus',
    'ExternalIPAddress',
    'X_HW_VLAN',
    'X_ZTE-COM_VLANID',
    'VLANID',
    'ServiceList',
    'ConnectionType',
  ]
  for (let wanDevice = 1; wanDevice <= 2; wanDevice++) {
    for (let wanConn = 1; wanConn <= 4; wanConn++) {
      for (let conn = 1; conn <= 4; conn++) {
        for (const field of fields) {
          params.push(`InternetGatewayDevice.WANDevice.${wanDevice}.WANConnectionDevice.${wanConn}.WANPPPConnection.${conn}.${field}`)
          params.push(`InternetGatewayDevice.WANDevice.${wanDevice}.WANConnectionDevice.${wanConn}.WANIPConnection.${conn}.${field}`)
        }
      }
    }
  }
  return params
}

const buildDeviceWanParams = () => {
  const params: string[] = []
  const pppFields = ['Name', 'Username', 'Password', 'Enable', 'Status', 'Alias']
  const ipFields = ['Name', 'Enable', 'Status', 'Alias']
  for (let i = 1; i <= 6; i++) {
    for (const field of pppFields) params.push(`Device.PPP.Interface.${i}.${field}`)
    params.push(`Device.PPP.Interface.${i}.IPCP.LocalIPAddress`)
    for (const field of ipFields) params.push(`Device.IP.Interface.${i}.${field}`)
    params.push(`Device.IP.Interface.${i}.IPv4Address.1.IPAddress`)
  }
  return params
}

const adminConfigParams = [
  'InternetGatewayDevice.UserInterface.X_HW_WebUserInfo.1.UserName',
  'InternetGatewayDevice.UserInterface.X_HW_WebUserInfo.1.Username',
  'InternetGatewayDevice.UserInterface.X_HW_WebUserInfo.1.Password',
  'InternetGatewayDevice.UserInterface.X_HW_UserInfo.1.UserName',
  'InternetGatewayDevice.UserInterface.X_HW_UserInfo.1.Username',
  'InternetGatewayDevice.UserInterface.X_HW_UserInfo.1.Password',
  'InternetGatewayDevice.UserInterface.X_ZTE-COM_UserInfo.1.Username',
  'InternetGatewayDevice.UserInterface.X_ZTE-COM_UserInfo.1.Password',
  'InternetGatewayDevice.UserInterface.X_FH_UserInfo.1.UserName',
  'InternetGatewayDevice.UserInterface.X_FH_UserInfo.1.Password',
  'InternetGatewayDevice.UserInterface.X_ALU-COM_UserInfo.1.Username',
  'InternetGatewayDevice.UserInterface.X_ALU-COM_UserInfo.1.Password',
  'Device.Users.User.1.Username',
  'Device.Users.User.1.Password',
]

export const igdBaseParams = [
  'InternetGatewayDevice.DeviceInfo.Manufacturer',
  'InternetGatewayDevice.DeviceInfo.ModelName',
  'InternetGatewayDevice.DeviceInfo.ProductClass',
  'InternetGatewayDevice.DeviceInfo.HardwareVersion',
  'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.AssociatedDeviceNumberOfEntries',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.PreSharedKey',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.TotalAssociations',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.AssociatedDeviceNumberOfEntries',
  'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress',
  'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.Status',
  'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MaxBitRate',
  'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.2.Status',
  'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.2.MaxBitRate',
  'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.3.Status',
  'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.3.MaxBitRate',
  'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.4.Status',
  'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.4.MaxBitRate',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Name',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Password',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.NATEnabled',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Enable',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ConnectionStatus',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.X_HW_VLAN',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.X_ZTE-COM_VLANID',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Name',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.NATEnabled',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Enable',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ConnectionStatus',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.X_HW_VLAN',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.X_ZTE-COM_VLANID',
  ...buildIgdWanParams(),
]

const deviceBaseParams = [
  'Device.DeviceInfo.Manufacturer',
  'Device.DeviceInfo.ModelName',
  'Device.DeviceInfo.ProductClass',
  'Device.DeviceInfo.HardwareVersion',
  'Device.DeviceInfo.SoftwareVersion',
  'Device.WiFi.SSID.1.SSID',
  'Device.WiFi.SSID.5.SSID',
  'Device.WiFi.AccessPoint.1.AssociatedDeviceNumberOfEntries',
  'Device.WiFi.AccessPoint.5.AssociatedDeviceNumberOfEntries',
  'Device.Ethernet.Interface.1.MACAddress',
  'Device.Ethernet.Interface.1.Status',
  'Device.Ethernet.Interface.2.Status',
  'Device.Ethernet.Interface.3.Status',
  'Device.Ethernet.Interface.4.Status',
  'Device.PPP.Interface.1.IPCP.LocalIPAddress',
  'Device.PPP.Interface.1.Username',
  'Device.PPP.Interface.1.Password',
  'Device.PPP.Interface.1.Enable',
  'Device.PPP.Interface.1.Status',
  'Device.PPP.Interface.1.Name',
  'Device.IP.Interface.1.IPv4Address.1.IPAddress',
  'Device.IP.Interface.1.Enable',
  'Device.IP.Interface.1.Status',
  'Device.IP.Interface.1.Name',
  ...buildDeviceWanParams(),
]

const opticalProfiles: Record<string, string[]> = {
  huawei: [
    'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.TXPower',
    'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.TransceiverTemperature',
    'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.SupplyVoltage',
    'InternetGatewayDevice.WANDevice.1.X_HW_GponInterface.RxOpticalPower',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_HW_GponInterface.RxOpticalPower',
  ],
  zte: [
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_GponInterface.RxOpticalPower',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_GponInterface.TxOpticalPower',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_GponInterface.Temperature',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_GponInterface.SupplyVoltage',
  ],
  fiberhome: [
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_FHTT_GponInterface.RxOpticalPower',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_FHTT_GponInterface.TxOpticalPower',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_FHTT_GponInterface.Temperature',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_FHTT_GponInterface.SupplyVoltage',
  ],
  nokia: [
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ALU_GponInterface.RxOpticalPower',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ALU_GponInterface.TxOpticalPower',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ALU_GponInterface.Temperature',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ALU_GponInterface.SupplyVoltage',
  ],
  generic: [
    'InternetGatewayDevice.WANDevice.1.X_GPON_Interface.RxOpticalPower',
    'InternetGatewayDevice.WANDevice.1.X_GPON_Interface.TxOpticalPower',
    'InternetGatewayDevice.WANDevice.1.X_GPON_Interface.TransceiverTemperature',
    'InternetGatewayDevice.WANDevice.1.X_GPON_Interface.SupplyVoltage',
    'InternetGatewayDevice.WANDevice.1.X_GponInterface.RxOpticalPower',
    'InternetGatewayDevice.WANDevice.1.X_GponInterface.TxOpticalPower',
    'InternetGatewayDevice.WANDevice.1.X_GponInterface.TransceiverTemperature',
    'InternetGatewayDevice.WANDevice.1.X_GponInterface.SupplyVoltage',
    'Device.Optical.Interface.1.RXPower',
    'Device.Optical.Interface.1.TXPower',
    'Device.Optical.Interface.1.TransceiverTemperature',
    'Device.Optical.Interface.1.SupplyVoltage',
  ],
}

export function detectVendor(manufacturer?: string | null, serial?: string | null) {
  const text = `${manufacturer || ''} ${serial || ''}`.toLowerCase()
  const sn = (serial || '').toUpperCase()
  if (text.includes('huawei') || sn.startsWith('485754') || sn.startsWith('HWTC')) return 'huawei'
  if (text.includes('zte') || sn.startsWith('5A5445') || sn.startsWith('ZTEG')) return 'zte'
  if (text.includes('fiberhome') || sn.startsWith('464854') || sn.startsWith('FHTT')) return 'fiberhome'
  if (text.includes('nokia') || text.includes('alcatel') || sn.startsWith('414C43') || sn.startsWith('ALCL')) return 'nokia'
  if (text.includes('vsol') || text.includes('v-sol') || text.includes('tp-link') || sn.startsWith('56534F') || sn.startsWith('VSOL') || sn.startsWith('54504C') || sn.startsWith('TPLG')) return 'generic'
  return 'generic'
}

export function buildParameterRequestList(manufacturer?: string | null, serial?: string | null, rootDataModel?: string | null) {
  if (rootDataModel === 'Device') {
    return uniqueParams([...deviceBaseParams, ...adminConfigParams, ...opticalProfiles.generic])
  }
  const vendor = detectVendor(manufacturer, serial)
  return uniqueParams([...igdBaseParams, ...adminConfigParams, ...(opticalProfiles[vendor] || []), ...opticalProfiles.generic])
}

/**
 * Parse respons GetParameterNames dari modem.
 * Mengembalikan array nama parameter leaf yang relevan untuk host list.
 */
export function parseGetParameterNamesResponse(xmlString: string): string[] {
  const hostIndexes = new Set<string>();
  const hasDeviceHosts = xmlString.includes('Device.Hosts.Host.');
  const hasIgdHosts = xmlString.includes('InternetGatewayDevice.LANDevice.1.Hosts.Host.');
  const hasDeviceWifi = xmlString.includes('Device.WiFi.AccessPoint.');
  const hasIgdWifi = xmlString.includes('InternetGatewayDevice.LANDevice.1.WLANConfiguration.');
  const hostsRegex = /<Name[^>]*>\s*(?:InternetGatewayDevice\.LANDevice\.1\.Hosts|Device\.Hosts)\.Host\.(\d+)\.?\s*<\/Name>/g;
  let match;
  while ((match = hostsRegex.exec(xmlString)) !== null) {
    hostIndexes.add(match[1]);
  }
  
  const params: string[] = [];
  for (const idx of hostIndexes) {
    const hostRoot = hasDeviceHosts && !hasIgdHosts ? `Device.Hosts.Host.${idx}` : `InternetGatewayDevice.LANDevice.1.Hosts.Host.${idx}`;
    params.push(`${hostRoot}.IPAddress`);
    params.push(`${hostRoot}.MACAddress`);
    params.push(`${hostRoot}.HostName`);
    params.push(`${hostRoot}.Active`);
  }

  // WLAN Associated Devices
  const wlanDevs = new Set<string>(); // format: "wlanIdx_devIdx"
  const wlanRegex = /<Name[^>]*>\s*(?:InternetGatewayDevice\.LANDevice\.1\.WLANConfiguration|Device\.WiFi\.AccessPoint)\.(\d+)\.AssociatedDevice\.(\d+)\.?\s*<\/Name>/g;
  while ((match = wlanRegex.exec(xmlString)) !== null) {
    wlanDevs.add(`${match[1]}_${match[2]}`);
  }

  for (const key of wlanDevs) {
    const [wlanIdx, devIdx] = key.split('_');
    if (hasDeviceWifi && !hasIgdWifi) {
      params.push(`Device.WiFi.AccessPoint.${wlanIdx}.AssociatedDevice.${devIdx}.MACAddress`);
      params.push(`Device.WiFi.AccessPoint.${wlanIdx}.AssociatedDevice.${devIdx}.IPAddress`);
    } else {
      params.push(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${wlanIdx}.AssociatedDevice.${devIdx}.AssociatedDeviceMACAddress`);
      params.push(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${wlanIdx}.AssociatedDevice.${devIdx}.AssociatedDeviceIPAddress`);
    }
  }

  console.log('[DEBUG CWMP] GetParameterNames - Hosts found:', hostIndexes.size, 'WLAN Associated found:', wlanDevs.size, 'yielding total', params.length, 'params');
  return params;
}

export function parseAllParameterNamesResponse(xmlString: string): string[] {
  const names: string[] = [];
  const regex = /<Name[^>]*>\s*([^<]+?)\s*<\/Name>/g;
  let match;
  while ((match = regex.exec(xmlString)) !== null) {
    const name = match[1].trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export function filterWanParameterNames(names: string[]) {
  const wantedSuffixes = [
    'Name',
    'Alias',
    'Username',
    'Password',
    'NATEnabled',
    'X_HW_NAT',
    'Enable',
    'ConnectionStatus',
    'Status',
    'ExternalIPAddress',
    'LocalIPAddress',
    'IPAddress',
    'X_HW_VLAN',
    'X_ZTE-COM_VLANID',
    'VLANID',
    'X_CT_COM_VLAN',
    'ServiceList',
    'ConnectionType',
    'LowerLayers',
  ];
  return names.filter(name => {
    const isWanPath =
      name.includes('WANPPPConnection.') ||
      name.includes('WANIPConnection.') ||
      name.includes('Device.PPP.Interface.') ||
      name.includes('Device.IP.Interface.') ||
      name.includes('Device.Ethernet.VLANTermination.') ||
      name.includes('Device.NAT.');
    if (!isWanPath) return false;
    return wantedSuffixes.some(suffix => name.endsWith(`.${suffix}`));
  });
}

/**
 * Parse hosts dari GetParameterValuesResponse yang berisi host params spesifik.
 * Menggabungkan tabel Hosts.Host. dan WLANConfiguration.i.AssociatedDevice.i.
 */
export function parseHostsFromGetParameterValues(xmlString: string): any[] {
  // 1. Parse dari Hosts.Host.
  const hostRegex = /<Name[^>]*>\s*(?:InternetGatewayDevice\.LANDevice\.1\.Hosts|Device\.Hosts)\.Host\.(\d+)\.(IPAddress|MACAddress|HostName|Active)\s*<\/Name>\s*<Value[^>]*>([\s\S]*?)<\/Value>/g;
  const hostsMap: Record<string, any> = {};
  let match;
  while ((match = hostRegex.exec(xmlString)) !== null) {
    const idx = match[1];
    const key = match[2];
    const val = match[3].trim();
    if (!hostsMap[idx]) hostsMap[idx] = {};
    hostsMap[idx][key] = val;
  }
  
  const hosts: any[] = [];
  for (const k in hostsMap) {
    if (hostsMap[k].MACAddress) {
      hosts.push({
        ip: hostsMap[k].IPAddress || '',
        mac: hostsMap[k].MACAddress,
        hostname: hostsMap[k].HostName || 'Unknown Device',
        active: hostsMap[k].Active === '1' || hostsMap[k].Active === 'true'
      });
    }
  }

  // 2. Parse dari WLANConfiguration.{i}.AssociatedDevice.{i}.
  const assocRegex = /<Name[^>]*>\s*(?:InternetGatewayDevice\.LANDevice\.1\.WLANConfiguration|Device\.WiFi\.AccessPoint)\.(\d+)\.AssociatedDevice\.(\d+)\.(AssociatedDeviceMACAddress|AssociatedDeviceIPAddress|MACAddress|IPAddress)\s*<\/Name>\s*<Value[^>]*>([\s\S]*?)<\/Value>/g;
  const assocMap: Record<string, any> = {};
  while ((match = assocRegex.exec(xmlString)) !== null) {
    const wlanIdx = match[1];
    const devIdx = match[2];
    const key = match[3] === 'MACAddress' ? 'AssociatedDeviceMACAddress' : match[3] === 'IPAddress' ? 'AssociatedDeviceIPAddress' : match[3];
    const val = match[4].trim();
    const compositeKey = `${wlanIdx}_${devIdx}`;
    if (!assocMap[compositeKey]) assocMap[compositeKey] = {};
    assocMap[compositeKey][key] = val;
  }

  for (const k in assocMap) {
    const mac = assocMap[k].AssociatedDeviceMACAddress;
    if (mac) {
      const normalizedMac = mac.toLowerCase().replace(/[^a-f0-9]/g, '');
      const duplicate = hosts.some(h => h.mac.toLowerCase().replace(/[^a-f0-9]/g, '') === normalizedMac);
      if (!duplicate) {
        hosts.push({
          ip: assocMap[k].AssociatedDeviceIPAddress || '',
          mac: mac,
          hostname: 'WiFi Client',
          active: true // Perangkat yang terasosiasi di AP pastilah aktif
        });
      }
    }
  }

  console.log('[DEBUG CWMP] parseHostsFromGetParameterValues - combined hosts:', hosts.length);
  return hosts;
}


export function parseParameterValueMap(xmlString: string): Record<string, string> {
  const map: Record<string, string> = {};
  const regex = /<Name[^>]*>\s*([^<]+?)\s*<\/Name>\s*<Value[^>]*>([\s\S]*?)<\/Value>/g;
  let match;
  while ((match = regex.exec(xmlString)) !== null) {
    map[match[1].trim()] = match[2].trim();
  }
  return map;
}

const findRawValue = (raw: Record<string, string>, patterns: RegExp[]) => {
  const found = Object.entries(raw).find(([name, value]) =>
    value !== '' && patterns.some(pattern => pattern.test(name))
  );
  return found?.[1] || null;
}

export function normalizeWanConfig(raw: Record<string, string>) {
  const groups = new Map<string, { values: Record<string, string>; fieldPaths: Record<string, string> }>();
  for (const [name, value] of Object.entries(raw)) {
    const match = name.match(/^(.*(?:WANPPPConnection|WANIPConnection|Device\.PPP\.Interface|Device\.IP\.Interface|Device\.Ethernet\.VLANTermination|Device\.NAT)\.\d+)\.(.+)$/);
    if (!match) continue;
    const [, base, key] = match;
    const group = groups.get(base) || { values: {}, fieldPaths: {} };
    group.values[key] = value;
    group.fieldPaths[key] = name;
    groups.set(base, group);
  }

  const normalized = [...groups.entries()].map(([base, group]) => {
    const item = group.values;
    const type = base.includes('WANPPPConnection') || base.includes('Device.PPP.Interface') ? 'PPPoE' : 'IPoE';
    const fieldPaths = {
      name: group.fieldPaths.Name || group.fieldPaths.Alias || null,
      username: group.fieldPaths.Username || null,
      password: group.fieldPaths.Password || null,
      nat: group.fieldPaths.NATEnabled || group.fieldPaths.X_HW_NAT || null,
      vlanId: group.fieldPaths.X_HW_VLAN || group.fieldPaths['X_ZTE-COM_VLANID'] || group.fieldPaths.VLANID || group.fieldPaths.X_CT_COM_VLAN || null,
      status: group.fieldPaths.ConnectionStatus || group.fieldPaths.Status || null,
      enable: group.fieldPaths.Enable || null,
      ipAddress: group.fieldPaths.ExternalIPAddress || group.fieldPaths.LocalIPAddress || group.fieldPaths['IPCP.LocalIPAddress'] || group.fieldPaths.IPAddress || group.fieldPaths['IPv4Address.1.IPAddress'] || null,
      serviceType: group.fieldPaths.ServiceList || group.fieldPaths.ConnectionType || null,
    };
    return {
      path: base,
      type,
      name: item.Name || item.ConnectionName || item.Alias || type,
      username: item.Username || null,
      password: item.Password || null,
      nat: item.NATEnabled || item.X_HW_NAT || null,
      vlanId: item.X_HW_VLAN || item['X_ZTE-COM_VLANID'] || item.VLANID || item.X_CT_COM_VLAN || null,
      status: item.ConnectionStatus || item.Status || null,
      enable: item.Enable || null,
      ipAddress: item.ExternalIPAddress || item.LocalIPAddress || item['IPCP.LocalIPAddress'] || item.IPAddress || item['IPv4Address.1.IPAddress'] || null,
      serviceType: item.ServiceList || item.ConnectionType || type,
      fieldPaths,
    };
  });

  if (normalized.length) return normalized;

  const username = findRawValue(raw, [/WANPPPConnection\.\d+\.Username$/, /Device\.PPP\.Interface\.\d+\.Username$/]);
  const ipAddress = findRawValue(raw, [/ExternalIPAddress$/, /LocalIPAddress$/, /IPv4Address\.\d+\.IPAddress$/]);
  if (!username && !ipAddress) return [];

  return [{
    path: null,
    type: username ? 'PPPoE' : 'IPoE',
    name: username ? 'PPPoE WAN' : 'WAN',
    username,
    password: findRawValue(raw, [/WANPPPConnection\.\d+\.Password$/, /Device\.PPP\.Interface\.\d+\.Password$/]),
    nat: findRawValue(raw, [/NATEnabled$/]),
    vlanId: findRawValue(raw, [/VLAN/i]),
    status: findRawValue(raw, [/ConnectionStatus$/, /Status$/]),
    enable: findRawValue(raw, [/Enable$/]),
    ipAddress,
    serviceType: username ? 'PPPoE' : 'IPoE',
  }];
}

export function parseInform(xmlString: string) {
  const getTagValue = (xml: string, tag: string) => {
    const match = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`));
    return match ? match[1] : null;
  };

  const getParameterValue = (xml: string, paramName: string) => {
    // Regex mencari blok Name-Value di ParameterValueStruct
    const regex = new RegExp(`<Name>${paramName}</Name>\\s*<Value[^>]*>(.*?)</Value>`);
    const match = xml.match(regex);
    return match ? match[1] : null;
  };

  // Ekstrak cwmp:ID dan namespace dari request modem
  const idMatch = xmlString.match(/<cwmp:ID[^>]*>([^<]+)<\/cwmp:ID>/i) || xmlString.match(/<ID[^>]*>([^<]+)<\/ID>/i);
  const cwmpId = idMatch ? idMatch[1] : '';

  const nsMatch = xmlString.match(/xmlns:cwmp="([^"]+)"/i) || xmlString.match(/xmlns:cwmp='([^']+)'/i);
  const cwmpNamespace = nsMatch ? nsMatch[1] : 'urn:dslforum-org:cwmp-1-0';

  const OUI = getTagValue(xmlString, 'OUI');
  const SerialNumber = getTagValue(xmlString, 'SerialNumber');
  const EventCode = getTagValue(xmlString, 'EventCode');
  
  // Ambil ConnectionRequestURL yang dikirim modem saat Inform
  const rootDataModel = xmlString.includes('Device.ManagementServer.') && !xmlString.includes('InternetGatewayDevice.ManagementServer.')
    ? 'Device'
    : 'InternetGatewayDevice';
  const connectionRequestUrl = getParameterValue(xmlString, 'InternetGatewayDevice.ManagementServer.ConnectionRequestURL') ||
                               getParameterValue(xmlString, 'Device.ManagementServer.ConnectionRequestURL');
  const ipAddress = getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress') ||
                    getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress') ||
                    getParameterValue(xmlString, 'Device.PPP.Interface.1.IPCP.LocalIPAddress') ||
                    getParameterValue(xmlString, 'Device.IP.Interface.1.IPv4Address.1.IPAddress');
  
  // Sesuai best practice, beberapa modem mengirim parameter spesifik ini di Inform
  // Ataupun kita fallback dengan regex sederhana pencarian Value (karena struktur bisa beda-beda)
  const extractValueByTag = (xml: string, tag: string) => {
    const match = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`)) || xml.match(new RegExp(`<Name>.*${tag}.*</Name>\\s*<Value[^>]*>(.*?)</Value>`));
    return match ? match[1] : null;
  }
  
  const ssid = extractValueByTag(xmlString, 'SSID') || getParameterValue(xmlString, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID');
  const wlanPassword = extractValueByTag(xmlString, 'KeyPassphrase') || extractValueByTag(xmlString, 'PreSharedKey') || getParameterValue(xmlString, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey');
  const rxPower = extractValueByTag(xmlString, 'RxOpticalPower') || extractValueByTag(xmlString, 'OpticalRxPower') || null;

  return {
    OUI,
    SerialNumber,
    EventCode,
    connectionRequestUrl,
    rootDataModel,
    ipAddress,
    ssid,
    wlanPassword,
    rxPower,
    cwmpId,
    cwmpNamespace,
    manufacturer: getTagValue(xmlString, 'Manufacturer') || getParameterValue(xmlString, 'Device.DeviceInfo.Manufacturer'),
    modelName: getTagValue(xmlString, 'ProductClass') || getParameterValue(xmlString, 'Device.DeviceInfo.ModelName') || getParameterValue(xmlString, 'Device.DeviceInfo.ProductClass'),
    hardwareVersion: getParameterValue(xmlString, 'InternetGatewayDevice.DeviceInfo.HardwareVersion') || getParameterValue(xmlString, 'Device.DeviceInfo.HardwareVersion'),
    softwareVersion: getParameterValue(xmlString, 'InternetGatewayDevice.DeviceInfo.SoftwareVersion') || getParameterValue(xmlString, 'Device.DeviceInfo.SoftwareVersion'),
    deviceId: `${OUI}-${SerialNumber}`
  };
}

// Ekstrak response dari GetParameterValues
export function parseGetParameterValuesResponse(xmlString: string) {
  const rawParams = parseParameterValueMap(xmlString);
  const wanConfig = normalizeWanConfig(rawParams);
  const getParameterValue = (xml: string, paramName: string) => {
    // Regex mencari blok Name-Value di ParameterValueStruct, mengabaikan namespace/prefix
    const escapedName = paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`<Name>${escapedName}</Name>\\s*<Value[^>]*>(.*?)</Value>`);
    const match = xml.match(regex);
    return match ? match[1] : null;
  };

  const firstValue = (...names: string[]) => {
    for (const name of names) {
      const value = getParameterValue(xmlString, name)
      if (value !== null && value !== undefined && value !== '') return value
    }
    return null
  }

  // LAN Ports Status Summary (LAN 1 - LAN 4)
  const lanPorts: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const status = firstValue(
      `InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.${i}.Status`,
      `Device.Ethernet.Interface.${i}.Status`
    );
    const speed = firstValue(
      `InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.${i}.MaxBitRate`,
      `Device.Ethernet.Interface.${i}.MaxBitRate`
    );
    if (status) {
      const speedStr = speed && speed !== '0' && speed !== '-1' ? `${speed}Mbps` : '';
      lanPorts.push(`LAN${i}:${status}${speedStr ? `(${speedStr})` : ''}`);
    }
  }
  const lanStatus = lanPorts.length > 0 ? lanPorts.join(', ') : null;

  // Associated Devices Sum (WLAN 2.4G + 5G)
  const assoc24 = parseInt(
    getParameterValue(xmlString, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations') ||
    getParameterValue(xmlString, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.AssociatedDeviceNumberOfEntries') ||
    getParameterValue(xmlString, 'Device.WiFi.AccessPoint.1.AssociatedDeviceNumberOfEntries') ||
    '0',
    10
  );
  const assoc50 = parseInt(
    getParameterValue(xmlString, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.TotalAssociations') ||
    getParameterValue(xmlString, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.AssociatedDeviceNumberOfEntries') ||
    getParameterValue(xmlString, 'Device.WiFi.AccessPoint.5.AssociatedDeviceNumberOfEntries') ||
    '0',
    10
  );
  const totalAssoc = (isNaN(assoc24) ? 0 : assoc24) + (isNaN(assoc50) ? 0 : assoc50);

  // Ekstrak Hosts (Daftar perangkat yang terhubung ke LAN/WLAN)
  // Note: Huawei EG8145V5 tidak mengembalikan Hosts.Host melalui GetParameterValues partial path.
  // Hosts akan diambil via GetParameterNames + GetParameterValues di stage terpisah (lihat index.ts).
  const connectedHosts: any[] = [];
  const hostRegex = /<Name>\s*InternetGatewayDevice\.LANDevice\.1\.Hosts\.Host\.(\d+)\.(IPAddress|MACAddress|HostName|Active)\s*<\/Name>\s*<Value[^>]*>([\s\S]*?)<\/Value>/g;
  let matchRegex;
  const hostsMap: Record<string, any> = {};

  console.log('[DEBUG CWMP] Mencari string Hosts.Host di XML:', xmlString.includes('InternetGatewayDevice.LANDevice.1.Hosts.Host.'));
  
  while ((matchRegex = hostRegex.exec(xmlString)) !== null) {
    const hostIndex = matchRegex[1];
    const paramKey = matchRegex[2];
    const paramValue = matchRegex[3];
    
    if (!hostsMap[hostIndex]) hostsMap[hostIndex] = {};
    hostsMap[hostIndex][paramKey] = paramValue;
  }
  
  for (const key in hostsMap) {
    if (hostsMap[key].MACAddress) {
      connectedHosts.push({
        ip: hostsMap[key].IPAddress || '',
        mac: hostsMap[key].MACAddress,
        hostname: hostsMap[key].HostName || 'Unknown Device',
        active: hostsMap[key].Active === '1' || hostsMap[key].Active === 'true'
      });
    }
  }

  console.log('[DEBUG CWMP] Hasil parsing hosts dari stage 1:', connectedHosts.length);

  const ssid = firstValue('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', 'Device.WiFi.SSID.1.SSID');
  const password = firstValue('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase', 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey');
  const ssid5g = firstValue('InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID', 'Device.WiFi.SSID.5.SSID');
  const password5g = firstValue('InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase', 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.PreSharedKey');

  return {
    ssid,
    password,
    ssid5g,
    password5g,
    wifiConfig: {
      radios: [
        { band: '2.4G', ssid, password, associatedDevices: isNaN(assoc24) ? 0 : assoc24 },
        { band: '5G', ssid: ssid5g, password: password5g, associatedDevices: isNaN(assoc50) ? 0 : assoc50 },
      ]
    },
    wanConfig,
    rawParams,
    lanStatus,
    associatedDevices: totalAssoc,
    connectedHosts,
    brand: firstValue('InternetGatewayDevice.DeviceInfo.Manufacturer', 'Device.DeviceInfo.Manufacturer'),
    modelName: firstValue('InternetGatewayDevice.DeviceInfo.ModelName', 'InternetGatewayDevice.DeviceInfo.ProductClass', 'Device.DeviceInfo.ModelName', 'Device.DeviceInfo.ProductClass'),
    hardwareVersion: firstValue('InternetGatewayDevice.DeviceInfo.HardwareVersion', 'Device.DeviceInfo.HardwareVersion'),
    softwareVersion: firstValue('InternetGatewayDevice.DeviceInfo.SoftwareVersion', 'Device.DeviceInfo.SoftwareVersion'),
    macAddress: firstValue('InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress', 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.MACAddress', 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.BSSID', 'Device.Ethernet.Interface.1.MACAddress'),
    wanIp: firstValue('InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress', 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress', 'Device.PPP.Interface.1.IPCP.LocalIPAddress', 'Device.IP.Interface.1.IPv4Address.1.IPAddress'),
    rxPower: firstValue('InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.RXPower', 'InternetGatewayDevice.WANDevice.1.X_HW_GponInterface.RxOpticalPower', 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_GponInterface.RxOpticalPower', 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_HW_GponInterface.RxOpticalPower', 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_FHTT_GponInterface.RxOpticalPower', 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ALU_GponInterface.RxOpticalPower', 'InternetGatewayDevice.WANDevice.1.X_GPON_Interface.RxOpticalPower', 'InternetGatewayDevice.WANDevice.1.X_GponInterface.RxOpticalPower', 'Device.Optical.Interface.1.RXPower'),
    txPower: firstValue('InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.TXPower', 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_GponInterface.TxOpticalPower', 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_FHTT_GponInterface.TxOpticalPower', 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ALU_GponInterface.TxOpticalPower', 'InternetGatewayDevice.WANDevice.1.X_GPON_Interface.TxOpticalPower', 'InternetGatewayDevice.WANDevice.1.X_GponInterface.TxOpticalPower', 'Device.Optical.Interface.1.TXPower'),
    temperature: firstValue('InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.TransceiverTemperature', 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_GponInterface.Temperature', 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_FHTT_GponInterface.Temperature', 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ALU_GponInterface.Temperature', 'InternetGatewayDevice.WANDevice.1.X_GPON_Interface.TransceiverTemperature', 'InternetGatewayDevice.WANDevice.1.X_GponInterface.TransceiverTemperature', 'Device.Optical.Interface.1.TransceiverTemperature'),
    voltage: firstValue('InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.SupplyVoltage', 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_GponInterface.SupplyVoltage', 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_FHTT_GponInterface.SupplyVoltage', 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ALU_GponInterface.SupplyVoltage', 'InternetGatewayDevice.WANDevice.1.X_GPON_Interface.SupplyVoltage', 'InternetGatewayDevice.WANDevice.1.X_GponInterface.SupplyVoltage', 'Device.Optical.Interface.1.SupplyVoltage')
  };
}

export function createSetParameterValues(
  cwmpId: string = '99997', 
  cwmpNamespace: string = 'urn:dslforum-org:cwmp-1-0', 
  params: { name: string; value: string; type: string }[] = []
) {
  const escapeXml = (value: string) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  const paramsXml = params.map(p => `
        <ParameterValueStruct>
          <Name>${escapeXml(p.name)}</Name>
          <Value xsi:type="xsd:${escapeXml(p.type)}">${escapeXml(p.value)}</Value>
        </ParameterValueStruct>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="${cwmpNamespace}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soap-env:Header>
    <cwmp:ID soap-env:mustUnderstand="1">${cwmpId}</cwmp:ID>
  </soap-env:Header>
  <soap-env:Body>
    <cwmp:SetParameterValues>
      <ParameterList soap-env:arrayType="cwmp:ParameterValueStruct[${params.length}]">
${paramsXml}
      </ParameterList>
      <ParameterKey>ConfigUpdate</ParameterKey>
    </cwmp:SetParameterValues>
  </soap-env:Body>
</soap-env:Envelope>`;
}
