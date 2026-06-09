interface Tool {
  id: string;
  name: string;
  description: string;
  icon: string;
  href?: string;
}

interface Config {
  tools: Tool[];
  openclawToken: string | null;
}

const config: Config = (window as any).__CONFIG__;
const container = document.getElementById("tools")!;

container.innerHTML = config.tools
  .map((t) => {
    const isExternal = !!t.href;
    const href = isExternal ? t.href : `/terminal?cmd=${t.id}`;
    const target = isExternal ? ' target="_blank" rel="noopener"' : "";
    const portAttr = isExternal
      ? ` data-port-href="${t.href}${config.openclawToken ? "#token=" + config.openclawToken : ""}"`
      : "";

    return `
      <a class="tool-card" href="${href}"${target}${portAttr}>
        <div class="tool-icon">
          <img src="${t.icon}" alt="${t.name}">
        </div>
        <div class="text-base font-semibold text-text-bright">${t.name}</div>
        <div class="text-xs text-text-muted leading-snug">${t.description}</div>
      </a>`;
  })
  .join("");

// Rewrite port-based hrefs to use the current hostname
document.querySelectorAll<HTMLAnchorElement>("[data-port-href]").forEach((a) => {
  a.href =
    location.protocol + "//" + location.hostname + a.dataset.portHref;
});
