export interface TemplateContext {
  mac: string;
  macHyphen: string;
  hostname: string;
  profileName: string;
  serverIp: string;
  baseUrl: string;
}

export interface TemplateHost {
  readonly hostname: string;
}

export interface TemplateProfile {
  readonly name: string;
}

/** Normalize a MAC address to lowercase colon-separated form. */
export function normalizeMac(mac: string): string {
  const clean = mac.toLowerCase().replace(/[:-]/g, '');
  if (clean.length !== 12 || !/^[0-9a-f]+$/.test(clean)) {
    throw new Error(`Invalid MAC address: ${mac}`);
  }
  return clean.match(/.{2}/g)!.join(':');
}

export function macToHyphen(mac: string): string {
  return mac.replace(/:/g, '-');
}

export function buildTemplateContext(
  mac: string,
  host: TemplateHost | null,
  profile: TemplateProfile | null,
  serverOrigin: string,
): TemplateContext {
  const normalizedMac = normalizeMac(mac);
  const url = new URL(serverOrigin);

  return {
    mac: normalizedMac,
    macHyphen: macToHyphen(normalizedMac),
    hostname: host?.hostname ?? 'unknown',
    profileName: profile?.name ?? 'default',
    serverIp: url.hostname,
    baseUrl: url.href.replace(/\/$/, ''),
  };
}

export function processTemplate(
  content: string,
  context: TemplateContext,
): string {
  return content
    .replace(/\{\{mac\}\}/gi, context.mac)
    .replace(/\{\{mac_hyphen\}\}/gi, context.macHyphen)
    .replace(/\{\{hostname\}\}/gi, context.hostname)
    .replace(/\{\{profile_name\}\}/gi, context.profileName)
    .replace(/\{\{server_ip\}\}/gi, context.serverIp)
    .replace(/\{\{base_url\}\}/gi, context.baseUrl);
}

export function localBootScript(mac: string): string {
  return `#!ipxe
# Spore: No profile assigned
echo Host ${mac} is not configured for network boot
echo Booting to local disk...
sleep 3
exit
`;
}

export function unregisteredHostScript(mac: string): string {
  return `#!ipxe
# Spore: Unknown host
echo Unknown host: ${mac}
echo Auto-registration is disabled
echo Booting to local disk...
sleep 3
exit
`;
}

export function invalidMacScript(mac: string): string {
  return `#!ipxe\necho Invalid MAC address: ${mac}\nexit\n`;
}

export function missingScript(path: string): string {
  return `#!ipxe\necho Script not found: ${path}\nsleep 3\nexit\n`;
}
