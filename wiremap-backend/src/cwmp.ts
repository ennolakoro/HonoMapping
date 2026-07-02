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

  return {
    ssid: getParameterValue(xmlString, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID'),
    password: getParameterValue(xmlString, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase') ||
              getParameterValue(xmlString, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey'),
    wanIp: getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress'),
    rxPower: getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.X_HW_GponInterface.RxOpticalPower') ||
             getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_GponInterface.RxOpticalPower') ||
             getParameterValue(xmlString, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_HW_GponInterface.RxOpticalPower')
  };
}
