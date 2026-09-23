import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Servicios externos para consultas en tiempo real (clima, web y puente Antigravity local).
 */

export interface WeatherResult {
  city: string;
  region?: string;
  country?: string;
  current: {
    temperature: number;
    apparentTemperature: number;
    humidity: number;
    windSpeed: number;
    condition: string;
  };
  daily?: {
    maxTemperature: number;
    minTemperature: number;
    precipitationProbabilityMax: number;
    condition: string;
  };
}

const WMO_CODE_DESCRIPTIONS: Record<number, string> = {
  0: "Cielo despejado",
  1: "Mayormente despejado",
  2: "Parcialmente nublado",
  3: "Nublado",
  45: "Niebla",
  48: "Niebla con escarcha",
  51: "Llovizna ligera",
  53: "Llovizna moderada",
  55: "Llovizna densa",
  56: "Llovizna helada ligera",
  57: "Llovizna helada densa",
  61: "Lluvia débil",
  63: "Lluvia moderada",
  65: "Lluvia fuerte",
  66: "Lluvia helada débil",
  67: "Lluvia helada fuerte",
  71: "Nevada débil",
  73: "Nevada moderada",
  75: "Nevada fuerte",
  77: "Granizo fino",
  80: "Chubascos de lluvia débiles",
  81: "Chubascos de lluvia moderados",
  82: "Chubascos de lluvia violentos",
  85: "Chubascos de nieve débiles",
  86: "Chubascos de nieve fuertes",
  95: "Tormenta eléctrica",
  96: "Tormenta con granizo leve",
  99: "Tormenta con granizo fuerte",
};

export function describeWmoCode(code: number): string {
  return WMO_CODE_DESCRIPTIONS[code] ?? `Condición meteorológica código ${code}`;
}

export async function getCurrentWeather(params: {
  city: string;
  country?: string;
}): Promise<string> {
  const city = params.city?.trim();
  if (!city) {
    return "Error: debes indicar el nombre de una ciudad o localidad.";
  }

  try {
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
      city
    )}&count=1&language=es`;
    const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(6000) });
    if (!geoRes.ok) {
      return `Error consultando el servicio de geocodificación (código ${geoRes.status}).`;
    }
    const geoData = (await geoRes.json()) as {
      results?: Array<{
        name: string;
        latitude: number;
        longitude: number;
        country?: string;
        admin1?: string;
      }>;
    };

    const location = geoData.results?.[0];
    if (!location) {
      return `No se ha encontrado ninguna localidad con el nombre "${city}".`;
    }

    const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto`;
    const forecastRes = await fetch(forecastUrl, { signal: AbortSignal.timeout(6000) });
    if (!forecastRes.ok) {
      return `Error consultando el pronóstico para ${location.name} (código ${forecastRes.status}).`;
    }

    const forecast = (await forecastRes.json()) as {
      current?: {
        temperature_2m: number;
        apparent_temperature: number;
        relative_humidity_2m: number;
        wind_speed_10m: number;
        weather_code: number;
      };
      daily?: {
        temperature_2m_max: number[];
        temperature_2m_min: number[];
        precipitation_probability_max: number[];
        weather_code: number[];
      };
    };

    if (!forecast.current) {
      return `Datos meteorológicos no disponibles para ${location.name}.`;
    }

    const currentCondition = describeWmoCode(forecast.current.weather_code);
    const dailyMax = forecast.daily?.temperature_2m_max?.[0];
    const dailyMin = forecast.daily?.temperature_2m_min?.[0];
    const rainProb = forecast.daily?.precipitation_probability_max?.[0];

    const lines: string[] = [
      `Ubicación: ${location.name}${location.admin1 ? `, ${location.admin1}` : ""}${
        location.country ? ` (${location.country})` : ""
      }`,
      `Estado actual: ${currentCondition}`,
      `Temperatura actual: ${forecast.current.temperature_2m}°C (sensación térmica: ${forecast.current.apparent_temperature}°C)`,
      `Humedad relativa: ${forecast.current.relative_humidity_2m}%`,
      `Viento: ${forecast.current.wind_speed_10m} km/h`,
    ];

    if (dailyMax !== undefined && dailyMin !== undefined) {
      lines.push(`Previsión hoy: Máx ${dailyMax}°C / Mín ${dailyMin}°C`);
    }
    if (rainProb !== undefined) {
      lines.push(`Probabilidad de precipitación hoy: ${rainProb}%`);
    }

    return lines.join("\n");
  } catch (err) {
    return `Error obteniendo datos meteorológicos: ${(err as Error).message}`;
  }
}

import net from "node:net";
import dns from "node:dns";
import crypto from "node:crypto";

export function isPrivateOrReservedIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return true;
  const nums = parts.map((p) => {
    if (!/^\d+$/.test(p)) return -1;
    return Number(p);
  });
  if (nums.some((n) => n < 0 || n > 255)) return true;

  const [a, b, c] = nums;
  if (a === 0) return true; // 0.0.0.0/8 (Red actual)
  if (a === 10) return true; // 10.0.0.0/8 (Privada RFC1918)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT RFC6598)
  if (a === 127) return true; // 127.0.0.0/8 (Loopback completo, ej. 127.0.0.2)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (Link-local / metadatos cloud)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (Privada RFC1918)
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (IETF Protocol Assignments)
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 (6to4 Relay Anycast)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (Privada RFC1918)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (Benchmarking)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true; // 224.0.0.0/4 (Multicast) y 240.0.0.0/4 (Reservado / Broadcast)
  return false;
}

function expandIPv6(ip: string): number[] | null {
  let working = ip;
  let embeddedIPv4Groups: number[] = [];
  const lastColon = working.lastIndexOf(":");
  if (lastColon !== -1) {
    const potentialIpv4 = working.slice(lastColon + 1);
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(potentialIpv4)) {
      const parts = potentialIpv4.split(".").map(Number);
      if (parts.length === 4 && parts.every((p) => p >= 0 && p <= 255)) {
        embeddedIPv4Groups = [
          (parts[0] << 8) | parts[1],
          (parts[2] << 8) | parts[3],
        ];
        working = working.slice(0, lastColon);
      }
    }
  }

  const doubleColonCount = (working.match(/::/g) || []).length;
  if (doubleColonCount > 1) return null;

  let headParts: string[] = [];
  let tailParts: string[] = [];

  if (doubleColonCount === 1) {
    const [head, tail] = working.split("::");
    headParts = head ? head.split(":") : [];
    tailParts = tail ? tail.split(":") : [];
  } else {
    headParts = working.split(":");
  }

  const headNums = headParts.map((p) => parseInt(p, 16));
  const tailNums = tailParts.map((p) => parseInt(p, 16));
  if (headNums.some(isNaN) || tailNums.some(isNaN)) return null;

  const totalKnown = headNums.length + tailNums.length + embeddedIPv4Groups.length;
  if (doubleColonCount === 0 && totalKnown !== 8) return null;
  if (totalKnown > 8) return null;

  const missingZeros = Array(8 - totalKnown).fill(0);
  return [...headNums, ...missingZeros, ...tailNums, ...embeddedIPv4Groups];
}

export function isPrivateOrReservedIPv6(ip: string): boolean {
  let cleaned = ip.toLowerCase();
  if (cleaned.startsWith("[") && cleaned.endsWith("]")) {
    cleaned = cleaned.slice(1, -1);
  }

  // IPv4-mapped IPv6 directo ::ffff:x.x.x.x
  const ipv4MappedMatch = cleaned.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (ipv4MappedMatch) {
    return isPrivateOrReservedIPv4(ipv4MappedMatch[1]);
  }

  if (cleaned === "::" || cleaned === "::1" || cleaned === "0:0:0:0:0:0:0:0" || cleaned === "0:0:0:0:0:0:0:1") {
    return true;
  }

  const groups = expandIPv6(cleaned);
  if (!groups || groups.length !== 8) {
    return true; // Formato inválido -> bloquear
  }

  const g0 = groups[0];
  const g1 = groups[1];

  // IPv4-mapped ::ffff:0:0/96
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const a = (groups[6] >> 8) & 0xff;
    const b = groups[6] & 0xff;
    const c = (groups[7] >> 8) & 0xff;
    const d = groups[7] & 0xff;
    return isPrivateOrReservedIPv4(`${a}.${b}.${c}.${d}`);
  }

  // Loopback (::1) y Unspecified (::)
  if (groups.slice(0, 7).every((g) => g === 0)) {
    if (groups[7] === 0 || groups[7] === 1) return true;
  }

  // Unique Local Address fc00::/7 (fc00:: a fdff::)
  if ((g0 & 0xfe00) === 0xfc00) return true;

  // Link-Local fe80::/10 (fe80:: a febf::)
  if ((g0 & 0xffc0) === 0xfe80) return true;

  // Multicast ff00::/8
  if ((g0 & 0xff00) === 0xff00) return true;

  // Documentación 2001:db8::/32
  if (g0 === 0x2001 && g1 === 0x0db8) return true;

  // Discard-Only 100::/64
  if (g0 === 0x0100 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0) return true;

  // 6to4 2002::/16
  if (g0 === 0x2002) {
    const a = (groups[1] >> 8) & 0xff;
    const b = groups[1] & 0xff;
    const c = (groups[2] >> 8) & 0xff;
    const d = groups[2] & 0xff;
    return isPrivateOrReservedIPv4(`${a}.${b}.${c}.${d}`);
  }

  return false;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const ipType = net.isIP(ip);
  if (ipType === 4) return isPrivateOrReservedIPv4(ip);
  if (ipType === 6) return isPrivateOrReservedIPv6(ip);
  return true;
}

export type DnsLookupFn = (
  hostname: string,
  options: { all: true }
) => Promise<Array<{ address: string; family: number }>>;

const defaultDnsLookup: DnsLookupFn = async (hostname, options) => {
  return (await dns.promises.lookup(hostname, options)) as Array<{ address: string; family: number }>;
};

/** Previene SSRF bloqueando hosts internos, locales, metadatos cloud y dominios que resuelven a IPs privadas (MUST-1). */
export async function isSafePublicUrl(
  urlString: string,
  lookupFn: DnsLookupFn = defaultDnsLookup
): Promise<boolean> {
  try {
    const url = new URL(urlString);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;

    // Rechazar credenciales en URL (user:pass@host)
    if (url.username || url.password) return false;

    // Normalizar hostname retirando puntos finales de FQDN (ej. metadata.google.internal.)
    let hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
    if (!hostname) return false;

    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      hostname = hostname.slice(1, -1);
    }

    // Comprobación de sufijos y nombres reservados
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".arpa") ||
      hostname.startsWith("internal.") ||
      hostname === "internal"
    ) {
      return false;
    }

    // Si es IP literal, comprobar rangos directamente
    const ipType = net.isIP(hostname);
    if (ipType !== 0) {
      return !isPrivateOrReservedIp(hostname);
    }

    // Si es nombre de dominio, resolver por DNS y verificar todas las IPs devueltas
    try {
      const addresses = await lookupFn(hostname, { all: true });
      if (!addresses || addresses.length === 0) {
        return false;
      }
      for (const entry of addresses) {
        if (isPrivateOrReservedIp(entry.address)) {
          return false;
        }
      }
    } catch {
      return false; // Error en resolución DNS -> fail-closed
    }

    return true;
  } catch {
    return false;
  }
}

export async function fetchWebContent(
  params: { url: string },
  lookupFn: DnsLookupFn = defaultDnsLookup
): Promise<string> {
  const url = params.url?.trim();
  if (!url) return "Error: URL no proporcionada.";

  let currentUrl = url;
  const maxRedirects = 3;
  let res: Response | null = null;

  try {
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
      const isSafe = await isSafePublicUrl(currentUrl, lookupFn);
      if (!isSafe) {
        return "Error: La URL no es válida o apunta a una dirección interna o restringida.";
      }

      res = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(6000),
        headers: {
          "User-Agent": "FornexaAiBot/1.0 (+https://fornexa.com)",
        },
      });

      // Manejo manual y seguro de redirecciones revalidando cada salto intermedio
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) {
          return `Error: Redirección sin cabecera Location (código ${res.status}).`;
        }
        if (redirectCount === maxRedirects) {
          return "Error: Se ha superado el número máximo de redirecciones permitidas (3).";
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      break;
    }

    if (!res || !res.ok) {
      return `Error al acceder a la URL (${res?.status ?? 500} ${res?.statusText ?? "Error"}).`;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (
      !contentType.includes("text/") &&
      !contentType.includes("application/json") &&
      !contentType.includes("application/xml")
    ) {
      return `Tipo de contenido no compatible (${contentType}). Solo se admite texto, HTML o JSON.`;
    }

    // Lectura con límite de streaming de 100 KB para evitar consumo desmedido de memoria
    const maxReadBytes = 100 * 1024;
    let bodyText = "";
    if (res.body) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          totalBytes += value.length;
          if (totalBytes >= maxReadBytes) {
            await reader.cancel();
            break;
          }
        }
      }
      bodyText = Buffer.concat(chunks).toString("utf8");
    } else {
      bodyText = await res.text();
    }

    // Limpieza de HTML
    const cleaned = bodyText
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .replace(/\s+([.,;:!?])/g, "$1")
      .trim();

    const maxChars = 20_000;
    if (cleaned.length > maxChars) {
      return cleaned.slice(0, maxChars) + "\n... [Contenido truncado a 20.000 caracteres]";
    }

    return cleaned || "El documento no contiene texto legible.";
  } catch (err) {
    return `Error al consultar la URL: ${(err as Error).message}`;
  }
}

/** Gestor en memoria para la comunicación segura con el sidecar local de Antigravity. */
interface PendingSidecarTask {
  id: string;
  task: string;
  payload?: Record<string, unknown>;
  createdAt: number;
  resolve: (result: string) => void;
  reject: (error: Error) => void;
}

export class SidecarManager {
  private lastHeartbeatMs: number = 0;
  private pendingQueue: PendingSidecarTask[] = [];
  private inFlightTasks = new Map<string, PendingSidecarTask>();
  private readonly HEARTBEAT_TIMEOUT_MS = 35_000; // 35 segundos

  recordHeartbeat(): void {
    this.lastHeartbeatMs = Date.now();
  }

  isOnline(): boolean {
    return Date.now() - this.lastHeartbeatMs < this.HEARTBEAT_TIMEOUT_MS;
  }

  async dispatchTask(task: string, payload?: Record<string, unknown>): Promise<string> {
    if (!this.isOnline()) {
      return (
        "El agente local de Antigravity en el Mac no está conectado en este momento (tu máquina parece estar en reposo o el sidecar local no está iniciado).\n" +
        "Las herramientas cloud (clima, enlaces web, consultas generales) siguen 100% disponibles."
      );
    }

    const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.inFlightTasks.delete(id);
        const index = this.pendingQueue.findIndex((t) => t.id === id);
        if (index >= 0) this.pendingQueue.splice(index, 1);
        resolve(
          "El agente local de Antigravity no respondió a tiempo (timeout de 20s). Comprueba el sidecar local en tu Mac."
        );
      }, 20_000);

      const item: PendingSidecarTask = {
        id,
        task,
        payload,
        createdAt: Date.now(),
        resolve: (val) => {
          clearTimeout(timeout);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      };

      this.pendingQueue.push(item);
      this.inFlightTasks.set(id, item);
    });
  }

  pollNextTask(): { id: string; task: string; payload?: Record<string, unknown> } | null {
    this.recordHeartbeat();
    const next = this.pendingQueue.shift();
    if (!next) return null;
    return { id: next.id, task: next.task, payload: next.payload };
  }

  completeTask(id: string, result: string, error?: string): boolean {
    this.recordHeartbeat();
    const item = this.inFlightTasks.get(id);
    if (!item) return false;
    this.inFlightTasks.delete(id);

    if (error) {
      item.resolve(`Error en el agente local: ${error}`);
    } else {
      item.resolve(result);
    }
    return true;
  }

  reset(): void {
    this.lastHeartbeatMs = 0;
    this.pendingQueue = [];
    this.inFlightTasks.clear();
  }
}

export const sidecarManager = new SidecarManager();

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export async function readRawBody(
  req: IncomingMessage,
  maxBytes = 1024 * 1024
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new Error("El cuerpo de la petición supera 1 MiB.");
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function verifySidecarAuth(
  req: IncomingMessage,
  expectedToken: string | null
): boolean {
  if (!expectedToken) return false;
  const headerToken = req.headers["x-sidecar-token"];
  if (typeof headerToken === "string" && timingSafeEqual(headerToken, expectedToken)) {
    return true;
  }
  const authHeader = req.headers["authorization"];
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return timingSafeEqual(authHeader.slice(7).trim(), expectedToken);
  }
  return false;
}

export async function handleSidecarPoll(
  req: IncomingMessage,
  res: ServerResponse,
  expectedToken: string | null,
  manager: SidecarManager = sidecarManager
): Promise<void> {
  if (!expectedToken) {
    sendJson(res, 503, { ok: false, error: "sidecar_not_configured" });
    return;
  }
  if (!verifySidecarAuth(req, expectedToken)) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }
  const task = manager.pollNextTask();
  sendJson(res, 200, { ok: true, task });
}

export async function handleSidecarResponse(
  req: IncomingMessage,
  res: ServerResponse,
  expectedToken: string | null,
  manager: SidecarManager = sidecarManager
): Promise<void> {
  if (!expectedToken) {
    sendJson(res, 503, { ok: false, error: "sidecar_not_configured" });
    return;
  }
  if (!verifySidecarAuth(req, expectedToken)) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }
  let rawBody: string;
  try {
    rawBody = await readRawBody(req);
  } catch {
    sendJson(res, 413, { ok: false, error: "request_too_large" });
    return;
  }
  let payload: { id?: string; result?: string; error?: string };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    sendJson(res, 400, { ok: false, error: "invalid_json" });
    return;
  }
  if (!payload.id || typeof payload.id !== "string") {
    sendJson(res, 400, { ok: false, error: "missing_task_id" });
    return;
  }
  const handled = manager.completeTask(
    payload.id,
    typeof payload.result === "string" ? payload.result : JSON.stringify(payload.result ?? ""),
    payload.error
  );
  sendJson(res, 200, { ok: true, handled });
}

