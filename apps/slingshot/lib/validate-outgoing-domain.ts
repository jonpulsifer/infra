// Outside production every domain passes. In production the hostname must be
// in the comma-separated WEBHOOK_ALLOWED_OUTGOING_DOMAINS, and unset denies all.
export function validateOutgoingDomain(url: string): {
  allowed: boolean;
  error?: string;
} {
  if (process.env.NODE_ENV !== 'production') {
    return { allowed: true };
  }

  const allowedDomains = process.env.WEBHOOK_ALLOWED_OUTGOING_DOMAINS;

  if (!allowedDomains) {
    return { allowed: false };
  }

  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    const allowedList = allowedDomains
      .split(',')
      .map((domain) => domain.trim().toLowerCase())
      .filter((domain) => domain.length > 0);

    const isAllowed = allowedList.some((allowedDomain) => {
      if (hostname === allowedDomain) {
        return true;
      }

      // *.example.com matches example.com and all of its subdomains.
      if (allowedDomain.startsWith('*.')) {
        const baseDomain = allowedDomain.slice(2);
        return hostname === baseDomain || hostname.endsWith(`.${baseDomain}`);
      }

      return false;
    });

    if (!isAllowed) {
      return {
        allowed: false,
        error: `Domain ${hostname} is not in the allowed list. Allowed domains: ${allowedDomains}`,
      };
    }

    return { allowed: true };
  } catch (error) {
    return {
      allowed: false,
      error: `Invalid URL format: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}
