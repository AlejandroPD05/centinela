import { lookup as dnsLookupCallback } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

/** El destino apunta a un rango que la guarda SSRF no permite tocar. */
export class SsrfBlockedError extends Error {
  override readonly name = 'SsrfBlockedError';
}

/**
 * Rangos que jamás deberían ser el destino de un monitor: bucle local, redes
 * privadas, enlaces de metadatos de nubes (169.254.169.254), CGNAT, rangos de
 * documentación, multicast…
 */
const blockedIpv4 = new BlockList();
blockedIpv4.addSubnet('0.0.0.0', 8, 'ipv4'); // "esta red"
blockedIpv4.addSubnet('10.0.0.0', 8, 'ipv4'); // RFC 1918
blockedIpv4.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT (RFC 6598)
blockedIpv4.addSubnet('127.0.0.0', 8, 'ipv4'); // bucle local
blockedIpv4.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local y metadatos
blockedIpv4.addSubnet('172.16.0.0', 12, 'ipv4'); // RFC 1918
blockedIpv4.addSubnet('192.0.0.0', 24, 'ipv4'); // protocolos especiales
blockedIpv4.addSubnet('192.0.2.0', 24, 'ipv4'); // TEST-NET-1
blockedIpv4.addSubnet('192.168.0.0', 16, 'ipv4'); // RFC 1918
blockedIpv4.addSubnet('198.18.0.0', 15, 'ipv4'); // pruebas de rendimiento
blockedIpv4.addSubnet('198.51.100.0', 24, 'ipv4'); // TEST-NET-2
blockedIpv4.addSubnet('203.0.113.0', 24, 'ipv4'); // TEST-NET-3
blockedIpv4.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
blockedIpv4.addSubnet('240.0.0.0', 4, 'ipv4'); // reservado (incluye broadcast)

const blockedIpv6 = new BlockList();
blockedIpv6.addAddress('::', 'ipv6'); // sin especificar
blockedIpv6.addAddress('::1', 'ipv6'); // bucle local
blockedIpv6.addSubnet('fc00::', 7, 'ipv6'); // direcciones locales únicas
blockedIpv6.addSubnet('fe80::', 10, 'ipv6'); // link-local
blockedIpv6.addSubnet('ff00::', 8, 'ipv6'); // multicast

type Ipv6Groups = [number, number, number, number, number, number, number, number];

/** ¿Esta dirección pertenece a un rango bloqueado? */
export function isBlockedIp(rawIp: string): boolean {
  const ip = normalizeHost(rawIp);

  switch (isIP(ip)) {
    case 4:
      return blockedIpv4.check(ip, 'ipv4');

    case 6: {
      // Formas con IPv4 embebida (mapeada, NAT64, 6to4): decide el IPv4 interno.
      const embedded = extractEmbeddedIpv4(ip) ?? extractDottedIpv4(ip);
      if (embedded) return isBlockedIp(embedded);
      return blockedIpv6.check(ip, 'ipv6');
    }

    default:
      return true; // Irreconocible: se bloquea por precaución.
  }
}

export interface SsrfGuardOptions {
  /** Solo para desarrollo local y tests: desactiva toda la guarda. */
  allowPrivateTargets: boolean;
}

/**
 * Comprueba que `host` (nombre o IP literal) no apunte a rangos prohibidos.
 * Devuelve las direcciones resueltas; vacío si la guarda está desactivada.
 */
export async function assertHostAllowed(
  rawHost: string,
  options: SsrfGuardOptions,
): Promise<string[]> {
  if (options.allowPrivateTargets) return [];

  const host = normalizeHost(rawHost);

  if (isIP(host) !== 0) {
    if (isBlockedIp(host)) {
      throw new SsrfBlockedError(`destino bloqueado por seguridad: ${host}`);
    }
    return [host];
  }

  const addresses = await lookup(host, { all: true, verbatim: true });
  for (const entry of addresses) {
    if (isBlockedIp(entry.address)) {
      throw new SsrfBlockedError(
        `«${host}» resuelve a una dirección bloqueada por seguridad (${entry.address})`,
      );
    }
  }

  return addresses.map((entry) => entry.address);
}

/** Guarda completa para destinos HTTP: protocolo permitido + host permitido. */
export async function assertAllowedUrl(url: URL, options: SsrfGuardOptions): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`protocolo no permitido: ${url.protocol}`);
  }
  await assertHostAllowed(url.hostname, options);
}

/** Quita corchetes (URLs IPv6) y zona (fe80::1%eth0). */
function normalizeHost(host: string): string {
  let clean = host;
  if (clean.startsWith('[') && clean.endsWith(']')) {
    clean = clean.slice(1, -1);
  }
  const zone = clean.indexOf('%');
  if (zone >= 0) clean = clean.slice(0, zone);
  return clean;
}

/** Expande un IPv6 a sus 8 grupos hexadecimales, o `null` si no es válido. */
function expandIpv6(ip: string): Ipv6Groups | null {
  if (!ip.includes(':')) return null;

  const halves = ip.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (head.length + tail.length > 8) return null;

  const missing = 8 - head.length - tail.length;
  const parts = [...head, ...Array.from({ length: missing }, () => '0'), ...tail];

  const groups: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }

  return [
    groups[0]!,
    groups[1]!,
    groups[2]!,
    groups[3]!,
    groups[4]!,
    groups[5]!,
    groups[6]!,
    groups[7]!,
  ];
}

/**
 * Extrae la IPv4 embebida de formas hexadecimales: `::ffff:h:h` (mapeada),
 * `::h:h` (compatible), `64:ff9b::h:h` (NAT64) y `2002::h:h` (6to4).
 */
function extractEmbeddedIpv4(ip: string): string | null {
  const groups = expandIpv6(ip);
  if (!groups) return null;

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const v4 = (hi: number, lo: number): string =>
    `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;

  // ::ffff:a.b.c.d — IPv4 mapeada
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return v4(g6, g7);
  }
  // ::a.b.c.d — IPv4 compatible (obsoleta)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return v4(g6, g7);
  }
  // 64:ff9b::/96 — NAT64
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return v4(g6, g7);
  }
  // 2002::/16 — 6to4
  if (g0 === 0x2002) {
    return `${(g1 >> 8) & 0xff}.${g1 & 0xff}.${(g2 >> 8) & 0xff}.${g2 & 0xff}`;
  }

  return null;
}

/** Extrae la IPv4 de formas con notación de puntos: `::ffff:127.0.0.1`. */
function extractDottedIpv4(ip: string): string | null {
  const match = /^(?<prefix>.*:)(?<v4>\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (!match?.groups) return null;

  const v4 = match.groups.v4;
  if (typeof v4 !== 'string' || isIP(v4) !== 4) return null;

  const prefix = match.groups.prefix;
  if (prefix === '::' || prefix === '::ffff:' || prefix === '64:ff9b::') return v4;

  // Prefijo desconocido con IPv4 embebida: mejor bloquear que adivinar.
  return '0.0.0.0';
}

// ── Guarda en el socket (anti DNS rebinding) ────────────────────────────────
// La comprobación previa resuelve el nombre, pero `fetch` vuelve a resolver por
// su cuenta un instante después: entre las dos ventanas cabe un DNS que cambie
// la respuesta (rebinding). Este agente valida cada dirección EN el momento de
// abrir el socket, así que la conexión real nunca va a un rango prohibido
// aunque el DNS haya cambiado entre medias.

type ResolveAll = (
  hostname: string,
  options: { all: true; verbatim: true },
  callback: (
    error: NodeJS.ErrnoException | null,
    addresses: Array<{ address: string; family: number }>,
  ) => void,
) => void;

const resolveAll: ResolveAll = (hostname, options, callback) => {
  dnsLookupCallback(hostname, options, callback);
};

/**
 * Crea un `lookup` de socket con la guarda aplicada: valida todas las
 * direcciones resueltas y entrega las permitidas. El resolvedor se inyecta en
 * los tests; en producción es el `dns.lookup` de Node.
 */
export function createGuardedLookup(resolver: ResolveAll = resolveAll): LookupFunction {
  return function guardedLookup(hostname, options, callback): void {
    resolver(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        callback(error, '');
        return;
      }

      for (const entry of addresses) {
        if (isBlockedIp(entry.address)) {
          callback(
            new SsrfBlockedError(
              `«${hostname}» resuelve a una dirección bloqueada por seguridad (${entry.address})`,
            ),
            '',
          );
          return;
        }
      }

      const filtered =
        options.family === 4 || options.family === 6
          ? addresses.filter((entry) => entry.family === options.family)
          : addresses;
      const usable = filtered.length > 0 ? filtered : addresses;

      if (options.all) {
        callback(null, usable);
        return;
      }

      const first = usable[0]!;
      callback(null, first.address, first.family);
    });
  };
}

/** Conexiones con la guarda pegada al socket (producción). */
const guardedAgent = new Agent({ connect: { lookup: createGuardedLookup() } });

/** Conexiones sin guarda, solo para `ALLOW_PRIVATE_TARGETS` (desarrollo). */
const openAgent = new Agent();

/** El agente de conexiones que corresponde según la configuración. */
export function agentFor(allowPrivateTargets: boolean): Dispatcher {
  return allowPrivateTargets ? openAgent : guardedAgent;
}

/**
 * `fetch` para destinos vigilados: valida protocolo y host antes de salir y,
 * con la guarda activa, la fija al socket para cerrar la ventana de rebinding.
 */
export async function safeFetch(
  target: string | URL,
  init: RequestInit = {},
  options: SsrfGuardOptions,
): Promise<Response> {
  const url = typeof target === 'string' ? new URL(target) : target;
  await assertAllowedUrl(url, options);

  // Se usa el `fetch` de undici (no el global) para que el agente y el
  // despachador sean de la misma versión; la respuesta se expone con el tipo
  // del `fetch` global, que es el que ven las rutas y los checkers.
  const response = await undiciFetch(url, {
    ...init,
    dispatcher: agentFor(options.allowPrivateTargets),
  });
  return response as unknown as Response;
}
