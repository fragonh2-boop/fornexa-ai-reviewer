import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  describeWmoCode,
  getCurrentWeather,
  isSafePublicUrl,
  fetchWebContent,
  SidecarManager,
  verifySidecarAuth,
  handleSidecarPoll,
  handleSidecarResponse,
} from "../src/tools/external-services.js";

function createMockReq(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const stream = new Readable({
    read() {
      if (options.body !== undefined) {
        this.push(Buffer.from(options.body, "utf8"));
      }
      this.push(null);
    },
  }) as unknown as IncomingMessage;
  stream.method = options.method ?? "GET";
  stream.url = options.url ?? "/";
  stream.headers = options.headers ?? {};
  return stream;
}

function createMockRes(): {
  res: ServerResponse;
  getStatus: () => number;
  getBody: () => string;
  getJson: () => any;
} {
  let statusCode = 200;
  let body = "";
  const res = {
    writeHead(status: number) {
      statusCode = status;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk) body += String(chunk);
      return this;
    },
    headersSent: false,
  } as unknown as ServerResponse;

  return {
    res,
    getStatus: () => statusCode,
    getBody: () => body,
    getJson: () => (body ? JSON.parse(body) : null),
  };
}

// ----------------------------------------------------
// 1. Clima y Open-Meteo
// ----------------------------------------------------

test("describeWmoCode devuelve descripción en español o fallback numérico", () => {
  assert.equal(describeWmoCode(0), "Cielo despejado");
  assert.equal(describeWmoCode(3), "Nublado");
  assert.equal(describeWmoCode(63), "Lluvia moderada");
  assert.equal(describeWmoCode(95), "Tormenta eléctrica");
  assert.equal(describeWmoCode(999), "Condición meteorológica código 999");
});

test("getCurrentWeather exige nombre de ciudad", async () => {
  const res = await getCurrentWeather({ city: "" });
  assert.match(res, /debes indicar el nombre de una ciudad/i);
});

test("getCurrentWeather procesa con éxito geocodificación y previsión meteorológica", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("geocoding-api.open-meteo.com")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                name: "Barcelona",
                latitude: 41.38879,
                longitude: 2.15899,
                country: "España",
                admin1: "Cataluña",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("api.open-meteo.com/v1/forecast")) {
        return new Response(
          JSON.stringify({
            current: {
              temperature_2m: 21.5,
              apparent_temperature: 22.0,
              relative_humidity_2m: 65,
              wind_speed_10m: 14.2,
              weather_code: 1,
            },
            daily: {
              temperature_2m_max: [24.0],
              temperature_2m_min: [17.0],
              precipitation_probability_max: [10],
              weather_code: [1],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    const weather = await getCurrentWeather({ city: "Barcelona" });
    assert.match(weather, /Ubicación: Barcelona, Cataluña \(España\)/);
    assert.match(weather, /Estado actual: Mayormente despejado/);
    assert.match(weather, /Temperatura actual: 21\.5°C/);
    assert.match(weather, /sensación térmica: 22°C/);
    assert.match(weather, /Humedad relativa: 65%/);
    assert.match(weather, /Viento: 14\.2 km\/h/);
    assert.match(weather, /Previsión hoy: Máx 24°C \/ Mín 17°C/);
    assert.match(weather, /Probabilidad de precipitación hoy: 10%/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getCurrentWeather informa si la ciudad no existe", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const res = await getCurrentWeather({ city: "CiudadInventada987" });
    assert.match(res, /No se ha encontrado ninguna localidad con el nombre "CiudadInventada987"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ----------------------------------------------------
// 2. Seguridad SSRF y Lectura Web
// ----------------------------------------------------

test("isSafePublicUrl bloquea IPs privadas, loopback, metadatos cloud y esquemas inseguros", () => {
  assert.equal(isSafePublicUrl("http://localhost"), false);
  assert.equal(isSafePublicUrl("http://localhost:3000/api"), false);
  assert.equal(isSafePublicUrl("http://127.0.0.1"), false);
  assert.equal(isSafePublicUrl("http://127.0.0.1:8080/secret"), false);
  assert.equal(isSafePublicUrl("http://0.0.0.0"), false);
  assert.equal(isSafePublicUrl("http://[::1]"), false);
  assert.equal(isSafePublicUrl("http://app.local"), false);
  assert.equal(isSafePublicUrl("http://internal.service"), false);
  assert.equal(isSafePublicUrl("http://169.254.169.254/latest/meta-data/"), false);
  assert.equal(isSafePublicUrl("http://10.0.0.5/admin"), false);
  assert.equal(isSafePublicUrl("http://192.168.1.100/"), false);
  assert.equal(isSafePublicUrl("http://172.16.0.1/"), false);
  assert.equal(isSafePublicUrl("http://172.31.255.254/"), false);
  assert.equal(isSafePublicUrl("ftp://fornexa.com/file.txt"), false);
  assert.equal(isSafePublicUrl("file:///etc/passwd"), false);
  assert.equal(isSafePublicUrl("not-a-url"), false);

  // URLs públicas válidas
  assert.equal(isSafePublicUrl("https://fornexa.com"), true);
  assert.equal(isSafePublicUrl("https://es.wikipedia.org/wiki/Barcelona"), true);
  assert.equal(isSafePublicUrl("http://example.com/page?q=test"), true);
});

test("fetchWebContent rechaza URLs no seguras o vacías sin invocar fetch", async () => {
  const res1 = await fetchWebContent({ url: "" });
  assert.match(res1, /URL no proporcionada/i);

  const res2 = await fetchWebContent({ url: "http://169.254.169.254/secret" });
  assert.match(res2, /URL no es válida o apunta a una dirección interna/i);
});

test("fetchWebContent extrae texto limpio de HTML y limpia scripts/estilos", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <style>body { color: red; }</style>
            <script>console.log("malicious code");</script>
          </head>
          <body>
            <h1>Noticia Importante</h1>
            <p>Fornexa lanza su nueva plataforma &amp; servicios.</p>
            <p>Texto con espacios&nbsp;&nbsp;y <b>negrita</b>.</p>
          </body>
        </html>
      `;
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    };

    const text = await fetchWebContent({ url: "https://example.com/noticia" });
    assert.doesNotMatch(text, /console\.log/);
    assert.doesNotMatch(text, /color: red/);
    assert.match(text, /Noticia Importante/);
    assert.match(text, /Fornexa lanza su nueva plataforma & servicios\./);
    assert.match(text, /Texto con espacios y negrita\./);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ----------------------------------------------------
// 3. SidecarManager (Colas, Heartbeat, Timeout)
// ----------------------------------------------------

test("SidecarManager responde que está offline si no ha recibido heartbeats", async () => {
  const manager = new SidecarManager();
  assert.equal(manager.isOnline(), false);

  const response = await manager.dispatchTask("ver git status");
  assert.match(response, /El agente local de Antigravity en el Mac no está conectado/);
});

test("SidecarManager encola tarea, poll la extrae y completeTask resuelve la promesa", async () => {
  const manager = new SidecarManager();
  manager.recordHeartbeat();
  assert.equal(manager.isOnline(), true);

  const taskPromise = manager.dispatchTask("ejecutar tests locales");

  const polled = manager.pollNextTask();
  assert.ok(polled);
  assert.equal(polled.task, "ejecutar tests locales");
  assert.ok(polled.id.startsWith("task_"));

  // El poll vacía la cola
  assert.equal(manager.pollNextTask(), null);

  const completed = manager.completeTask(polled.id, "Todos los tests han pasado con éxito (10/10).");
  assert.equal(completed, true);

  const result = await taskPromise;
  assert.equal(result, "Todos los tests han pasado con éxito (10/10).");
});

test("SidecarManager propaga error del agente local", async () => {
  const manager = new SidecarManager();
  manager.recordHeartbeat();

  const taskPromise = manager.dispatchTask("ver logs");
  const polled = manager.pollNextTask();
  assert.ok(polled);

  manager.completeTask(polled.id, "", "Comando no autorizado en entorno local");
  const result = await taskPromise;
  assert.equal(result, "Error en el agente local: Comando no autorizado en entorno local");
});

// ----------------------------------------------------
// 4. Endpoints HTTP del Sidecar (/sidecar/poll y /sidecar/response)
// ----------------------------------------------------

test("verifySidecarAuth valida token en header x-sidecar-token y Bearer token", () => {
  assert.equal(verifySidecarAuth(createMockReq({}), "secret-123"), false);
  assert.equal(
    verifySidecarAuth(
      createMockReq({ headers: { "x-sidecar-token": "wrong-token" } }),
      "secret-123"
    ),
    false
  );
  assert.equal(
    verifySidecarAuth(
      createMockReq({ headers: { "x-sidecar-token": "secret-123" } }),
      "secret-123"
    ),
    true
  );
  assert.equal(
    verifySidecarAuth(
      createMockReq({ headers: { authorization: "Bearer secret-123" } }),
      "secret-123"
    ),
    true
  );
});

test("handleSidecarPoll rechaza petición si el token no está configurado o es inválido", async () => {
  const manager = new SidecarManager();

  // No configurado
  const mock1 = createMockRes();
  await handleSidecarPoll(createMockReq({}), mock1.res, null, manager);
  assert.equal(mock1.getStatus(), 503);
  assert.deepEqual(mock1.getJson(), { ok: false, error: "sidecar_not_configured" });

  // Unauthorized
  const mock2 = createMockRes();
  await handleSidecarPoll(
    createMockReq({ headers: { "x-sidecar-token": "bad" } }),
    mock2.res,
    "correct-token",
    manager
  );
  assert.equal(mock2.getStatus(), 401);
  assert.deepEqual(mock2.getJson(), { ok: false, error: "unauthorized" });
});

test("handleSidecarPoll y handleSidecarResponse ciclo completo con autenticación", async () => {
  const manager = new SidecarManager();
  manager.recordHeartbeat();
  const token = "secure-sidecar-secret";

  // Encolamos una tarea
  const taskPromise = manager.dispatchTask("inspeccionar cambios git");

  // El sidecar hace poll
  const pollMock = createMockRes();
  await handleSidecarPoll(
    createMockReq({
      method: "POST",
      headers: { "x-sidecar-token": token },
    }),
    pollMock.res,
    token,
    manager
  );
  assert.equal(pollMock.getStatus(), 200);
  const pollJson = pollMock.getJson();
  assert.equal(pollJson.ok, true);
  assert.ok(pollJson.task);
  assert.equal(pollJson.task.task, "inspeccionar cambios git");

  // El sidecar envía respuesta
  const respMock = createMockRes();
  await handleSidecarResponse(
    createMockReq({
      method: "POST",
      headers: { "x-sidecar-token": token },
      body: JSON.stringify({
        id: pollJson.task.id,
        result: "Rama limpia, sin modificaciones pendientes.",
      }),
    }),
    respMock.res,
    token,
    manager
  );
  assert.equal(respMock.getStatus(), 200);
  assert.deepEqual(respMock.getJson(), { ok: true, handled: true });

  const finalResult = await taskPromise;
  assert.equal(finalResult, "Rama limpia, sin modificaciones pendientes.");
});
