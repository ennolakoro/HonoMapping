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
export function createGetParameterNames(cwmpId: string = '99998', cwmpNamespace: string = 'urn:dslforum-org:cwmp-1-0', paramPath: string = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="${cwmpNamespace}">
  <soap-env:Header>
    <cwmp:ID soap-env:mustUnderstand="1">${cwmpId}</cwmp:ID>
  </soap-env:Header>
  <soap-env:Body>
    <cwmp:GetParameterNames>
      <ParameterPath>${paramPath}</ParameterPath>
      <NextLevel>false</NextLevel>
    </cwmp:GetParameterNames>
  </soap-env:Body>
</soap-env:Envelope>`;
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
  const connectionRequestUrl = getParameterValue(xmlString, 'InternetGatewayDevice.ManagementServer.ConnectionRequestURL');
  const ipAddress = getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress');
  
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
    ipAddress,
    ssid,
    wlanPassword,
    rxPower,
    cwmpId,
    cwmpNamespace,
    manufacturer: getTagValue(xmlString, 'Manufacturer'),
    modelName: getTagValue(xmlString, 'ProductClass'),
    hardwareVersion: getParameterValue(xmlString, 'InternetGatewayDevice.DeviceInfo.HardwareVersion'),
    softwareVersion: getParameterValue(xmlString, 'InternetGatewayDevice.DeviceInfo.SoftwareVersion'),
    deviceId: `${OUI}-${SerialNumber}`
  };
}

// Ekstrak response dari GetParameterValues
export function parseGetParameterValuesResponse(xmlString: string) {
  const getParameterValue = (xml: string, paramName: string) => {
    // Regex mencari blok Name-Value di ParameterValueStruct, mengabaikan namespace/prefix
    const regex = new RegExp(`<Name>${paramName.replace(/\./g, '\\.')}</Name>\\s*<Value[^>]*>(.*?)</Value>`);
    const match = xml.match(regex);
    return match ? match[1] : null;
  };

  // LAN Ports Status Summary (LAN 1 - LAN 4)
  const lanPorts: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const status = getParameterValue(xmlString, `InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.${i}.Status`);
    const speed = getParameterValue(xmlString, `InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.${i}.MaxBitRate`);
    if (status) {
      const speedStr = speed && speed !== '0' && speed !== '-1' ? `${speed}Mbps` : '';
      lanPorts.push(`LAN${i}:${status}${speedStr ? `(${speedStr})` : ''}`);
    }
  }
  const lanStatus = lanPorts.length > 0 ? lanPorts.join(', ') : null;

export function parseGetParameterValuesResponse(xmlString: string) {
  const getParameterValue = (xml: string, paramName: string) => {
    // Regex mencari blok Name-Value di ParameterValueStruct, mengabaikan namespace/prefix
    const regex = new RegExp(`<Name>${paramName.replace(/\./g, '\\.')}</Name>\\s*<Value[^>]*>(.*?)</Value>`);
    const match = xml.match(regex);
    return match ? match[1] : null;
  };

  // LAN Ports Status Summary (LAN 1 - LAN 4)
  const lanPorts: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const status = getParameterValue(xmlString, `InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.${i}.Status`);
    const speed = getParameterValue(xmlString, `InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.${i}.MaxBitRate`);
    if (status) {
      const speedStr = speed && speed !== '0' && speed !== '-1' ? `${speed}Mbps` : '';
      lanPorts.push(`LAN${i}:${status}${speedStr ? `(${speedStr})` : ''}`);
    }
  }
  const lanStatus = lanPorts.length > 0 ? lanPorts.join(', ') : null;

  // Associated Devices Sum (WLAN 2.4G + 5G)
  const assoc24 = parseInt(getParameterValue(xmlString, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations') || '0', 10);
  const assoc50 = parseInt(getParameterValue(xmlString, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.TotalAssociations') || '0', 10);
  const totalAssoc = (isNaN(assoc24) ? 0 : assoc24) + (isNaN(assoc50) ? 0 : assoc50);

  // Ekstrak Hosts (Daftar perangkat yang terhubung ke LAN/WLAN)
  const connectedHosts: any[] = [];
  const hostRegex = /<Name>InternetGatewayDevice\.LANDevice\.1\.Hosts\.Host\.(\d+)\.(IPAddress|MACAddress|HostName|Active)<\/Name>\s*<Value[^>]*>(.*?)<\/Value>/g;
  let matchRegex;
  const hostsMap: Record<string, any> = {};
  
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

  return {
    ssid: getParameterValue(xmlString, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID'),
    password: getParameterValue(xmlString, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase') ||
              getParameterValue(xmlString, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey'),
    ssid5g: getParameterValue(xmlString, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID'),
    password5g: getParameterValue(xmlString, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase') ||
                getParameterValue(xmlString, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.PreSharedKey'),
    lanStatus,
    associatedDevices: totalAssoc,
    connectedHosts,
    brand: getParameterValue(xmlString, 'InternetGatewayDevice.DeviceInfo.Manufacturer'),
    modelName: getParameterValue(xmlString, 'InternetGatewayDevice.DeviceInfo.ModelName') ||
               getParameterValue(xmlString, 'InternetGatewayDevice.DeviceInfo.ProductClass'),
    hardwareVersion: getParameterValue(xmlString, 'InternetGatewayDevice.DeviceInfo.HardwareVersion'),
    softwareVersion: getParameterValue(xmlString, 'InternetGatewayDevice.DeviceInfo.SoftwareVersion'),
    macAddress: getParameterValue(xmlString, 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress') ||
                getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.MACAddress') ||
                getParameterValue(xmlString, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.BSSID'),
    wanIp: getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress'),
    rxPower: getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.RXPower') ||
             getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.X_HW_GponInterface.RxOpticalPower') ||
             getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_GponInterface.RxOpticalPower') ||
             getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_HW_GponInterface.RxOpticalPower') ||
             getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_FHTT_GponInterface.RxOpticalPower') ||
             getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ALU_GponInterface.RxOpticalPower') ||
             getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.X_GPON_Interface.RxOpticalPower') ||
             getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.X_GponInterface.RxOpticalPower'),
    txPower: getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.TXPower') ||
             getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_GponInterface.TxOpticalPower') ||
             getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_FHTT_GponInterface.TxOpticalPower') ||
             getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ALU_GponInterface.TxOpticalPower') ||
             getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.X_GPON_Interface.TxOpticalPower') ||
             getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.X_GponInterface.TxOpticalPower'),
    temperature: getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.TransceiverTemperature') ||
                 getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_GponInterface.Temperature') ||
                 getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_FHTT_GponInterface.Temperature') ||
                 getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ALU_GponInterface.Temperature') ||
                 getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.X_GPON_Interface.TransceiverTemperature') ||
                 getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.X_GponInterface.TransceiverTemperature'),
    voltage: getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.SupplyVoltage') ||
             getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_GponInterface.SupplyVoltage') ||
             getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_FHTT_GponInterface.SupplyVoltage') ||
             getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ALU_GponInterface.SupplyVoltage') ||
             getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.X_GPON_Interface.SupplyVoltage') ||
             getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.X_GponInterface.SupplyVoltage')
  };
}

export function createSetParameterValues(
  cwmpId: string = '99997', 
  cwmpNamespace: string = 'urn:dslforum-org:cwmp-1-0', 
  params: { name: string; value: string; type: string }[] = []
) {
  const paramsXml = params.map(p => `
        <ParameterValueStruct>
          <Name>${p.name}</Name>
          <Value xsi:type="xsd:${p.type}">${p.value}</Value>
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
