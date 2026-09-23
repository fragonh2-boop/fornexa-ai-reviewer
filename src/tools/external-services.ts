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

/** Previene SSRF bloqueando hosts internos, locales y metadatos de cloud. */
export function isSafePublicUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    let hostname = url.hostname.toLowerCase();
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      hostname = hostname.slice(1, -1);
    }

    // IPs loopback y privadas
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname === "::" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.startsWith("internal.") ||
      hostname === "internal"
    ) {
      return false;
    }

    // Rango metadatos cloud (169.254.x.x) y redes privadas (10.x, 192.168.x, 172.16-31.x)
    if (/^169\.254\./.test(hostname)) return false;
    if (/^10\./.test(hostname)) return false;
    if (/^192\.168\./.test(hostname)) return false;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)) return false;

    return true;
  } catch {
    return false;
  }
}

export async function fetchWebContent(params: { url: string }): Promise<string> {
  const url = params.url?.trim();
  if (!url) return "Error: URL no proporcionada.";
  if (!isSafePublicUrl(url)) {
    return "Error: La URL no es válida o apunta a una dirección interna o restringida.";
  }

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: {
        "User-Agent": "FornexaAiBot/1.0 (+https://fornexa.com)",
      },
    });

    if (!res.ok) {
      return `Error al acceder a la URL (${res.status} ${res.statusText}).`;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (
      !contentType.includes("text/") &&
      !contentType.includes("application/json") &&
      !contentType.includes("application/xml")
    ) {
      return `Tipo de contenido no compatible (${contentType}). Solo se admite texto, HTML o JSON.`;
    }

    const html = await res.text();
    // Limpieza básica de HTML
    const cleaned = html
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

export function verifySidecarAuth(
  req: IncomingMessage,
  expectedToken: string | null
): boolean {
  if (!expectedToken) return false;
  const headerToken = req.headers["x-sidecar-token"];
  if (typeof headerToken === "string" && headerToken === expectedToken) {
    return true;
  }
  const authHeader = req.headers["authorization"];
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim() === expectedToken;
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

