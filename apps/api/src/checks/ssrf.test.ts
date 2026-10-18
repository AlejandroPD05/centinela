import { describe, expect, it } from 'vitest';
import {
  assertAllowedUrl,
  assertHostAllowed,
  createGuardedLookup,
  isBlockedIp,
  safeFetch,
  SsrfBlockedError,
} from './ssrf.js';

describe('isBlockedIp — rangos IPv4', () => {
  it.each([
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '100.64.12.9',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.5.4',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.7',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
  ])('bloquea %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '100.63.255.255',
    '100.128.0.0',
    '172.15.255.255',
    '172.32.0.0',
    '192.167.255.255',
    '198.17.255.255',
  ])('permite %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

describe('isBlockedIp — IPv6 y formas embebidas', () => {
  it.each([
    '::',
    '::1',
    '[::1]',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
  ])('bloquea %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(['2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808'])('permite %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it('bloquea cualquier cosa que no sea una IP reconocible', () => {
    expect(isBlockedIp('no-es-una-ip')).toBe(true);
  });
});

describe('assertHostAllowed', () => {
  it('rechaza direcciones literales privadas', async () => {
    await expect(
      assertHostAllowed('127.0.0.1', { allowPrivateTargets: false }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('permite literales públicas y las devuelve', async () => {
    await expect(assertHostAllowed('8.8.8.8', { allowPrivateTargets: false })).resolves.toEqual([
      '8.8.8.8',
    ]);
  });

  it('con allowPrivateTargets no comprueba nada (desarrollo y tests)', async () => {
    await expect(assertHostAllowed('10.0.0.5', { allowPrivateTargets: true })).resolves.toEqual([]);
  });

  it('acepta IPv6 con corchetes tal y como lo entrega URL', async () => {
    await expect(assertHostAllowed('[::1]', { allowPrivateTargets: false })).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });
});

describe('assertAllowedUrl', () => {
  it('rechaza protocolos que no sean http o https', async () => {
    await expect(
      assertAllowedUrl(new URL('ftp://example.com/'), { allowPrivateTargets: false }),
    ).rejects.toThrow('protocolo');
  });

  it('rechaza el endpoint de metadatos de las nubes', async () => {
    await expect(
      assertAllowedUrl(new URL('http://169.254.169.254/latest/meta-data'), {
        allowPrivateTargets: false,
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('permite URLs públicas', async () => {
    await expect(
      assertAllowedUrl(new URL('https://example.com/estado'), { allowPrivateTargets: false }),
    ).resolves.toBeUndefined();
  });
});

describe('createGuardedLookup — la guarda pegada al socket', () => {
  const resolverFalso =
    (addresses: Array<{ address: string; family: number }>) =>
    (
      _hostname: string,
      _options: { all: true; verbatim: true },
      callback: (
        error: NodeJS.ErrnoException | null,
        out: Array<{ address: string; family: number }>,
      ) => void,
    ): void => {
      callback(null, addresses);
    };

  // Ejecuta el lookup y resume el callback en una promesa.
  const resolver = (
    lookup: ReturnType<typeof createGuardedLookup>,
    options: { family?: number; all?: boolean } = {},
  ) =>
    new Promise<{
      error: Error | null;
      address?: string | Array<{ address: string; family: number }>;
      family?: number;
    }>((resolve) => {
      lookup('objetivo.test', options, (error, address, family) =>
        resolve({ error, address, family }),
      );
    });

  it('entrega la primera dirección cuando el resolvedor da varias', async () => {
    const lookup = createGuardedLookup(
      resolverFalso([
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1::1', family: 6 },
      ]),
    );

    await expect(resolver(lookup)).resolves.toEqual({
      error: null,
      address: '93.184.216.34',
      family: 4,
    });
  });

  it('bloquea el socket si el DNS responde con una dirección prohibida', async () => {
    const lookup = createGuardedLookup(resolverFalso([{ address: '127.0.0.1', family: 4 }]));
    const { error } = await resolver(lookup);

    expect(error).toBeInstanceOf(SsrfBlockedError);
    expect(error?.message).toContain('127.0.0.1');
  });

  it('bloquea aunque solo una de las direcciones sea privada (rebinding selectivo)', async () => {
    const lookup = createGuardedLookup(
      resolverFalso([
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.7', family: 4 },
      ]),
    );

    const { error } = await resolver(lookup);
    expect(error).toBeInstanceOf(SsrfBlockedError);
  });

  it('con `all` entrega la lista entera y respeta la familia pedida', async () => {
    const direcciones = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::1', family: 6 },
    ];

    const todas = await resolver(createGuardedLookup(resolverFalso(direcciones)), { all: true });
    expect(todas.address).toEqual(direcciones);

    const soloV6 = await resolver(createGuardedLookup(resolverFalso(direcciones)), {
      all: true,
      family: 6,
    });
    expect(soloV6.address).toEqual([{ address: '2606:2800:220:1::1', family: 6 }]);
  });

  it('propaga los errores del resolvedor sin tocarlos', async () => {
    const lookup = createGuardedLookup((_hostname, _options, callback) => {
      callback(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []);
    });

    const { error } = await resolver(lookup);
    expect(error?.message).toBe('ENOTFOUND');
  });
});

describe('safeFetch — validación previa y de socket', () => {
  it('rechaza IPs literales privadas antes de salir a la red', async () => {
    await expect(
      safeFetch('http://127.0.0.1:9/', {}, { allowPrivateTargets: false }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('rechaza protocolos que no sean http o https', async () => {
    await expect(
      safeFetch('ftp://example.com/', {}, { allowPrivateTargets: false }),
    ).rejects.toThrow('protocolo');
  });

  it('con allowPrivateTargets deja pasar el destino privado (y falla al conectar, no por la guarda)', async () => {
    const fallo = await safeFetch('http://127.0.0.1:9/', {}, { allowPrivateTargets: true }).catch(
      (error: unknown) => error,
    );

    expect(fallo).toBeInstanceOf(Error);
    expect(fallo).not.toBeInstanceOf(SsrfBlockedError);
  });
});
