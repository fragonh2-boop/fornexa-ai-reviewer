# fornexa-ai-reviewer

Agente independiente basado en DeepSeek para el flujo de desarrollo de Fornexa.
Cubre, para empezar, **segunda revisión independiente** en cambios críticos
(la base también sirve para el rol de árbitro más adelante).

No es un fork de Claude ni de GPT: es un proceso propio, con su propio token
de Slack y su propio token de GitHub, ambos de solo lectura salvo la única
excepción necesaria para poder comentar en una PR.

## Por qué existe este repo aparte

Vive separado del repo de producto (`Fornexa`) a propósito: así sus
credenciales, su despliegue y su ciclo de vida no se mezclan con el código
que sí llega a producción.

## Qué necesita Fran para activarlo (nada de esto lo puede hacer el agente por sí solo)

1. **Clave de DeepSeek**: crear cuenta/API key en https://platform.deepseek.com
   → variable `DEEPSEEK_API_KEY`.
2. **App de Slack propia** en el workspace `fornexasc.slack.com`:
   - Crear una app nueva (api.slack.com/apps → "Create New App").
   - Scopes de Bot Token necesarios: `channels:history`, `chat:write`, `channels:read`.
   - Instalarla en el workspace e **invitar el bot al canal `#fornexa`**
     (si no, no podrá leer ni escribir ahí).
   - Copiar el "Bot User OAuth Token" (empieza por `xoxb-`) → `SLACK_BOT_TOKEN`.
3. **Token de GitHub de solo lectura + comentario**, limitado al repo `Fornexa`:
   - GitHub → Settings → Developer settings → Fine-grained tokens → New token.
   - Repository access: solo `fragonh2-boop/Fornexa`.
   - Permisos: `Contents: Read-only`, `Pull requests: Read and write`,
     `Checks: Read-only`. Nada más — en particular, nunca `Contents: Write`
     sobre `main` ni `Administration`.
   - → `GITHUB_TOKEN`.
4. Copiar `.env.example` a `.env` y rellenar los tres valores anteriores.

## Cómo se activa (convención de mensaje en Slack)

Este agente solo actúa cuando detecta en `#fornexa` un mensaje que contiene
literalmente:

```
DEEPSEEK — ACCIÓN REQUERIDA
...
PR #<número>
```

Es la misma convención que ya usáis entre GPT y Claude (`CLAUDE — ACCIÓN
REQUERIDA`), así que basta con que GPT (o Fran) escriba ese marcador cuando
un cambio sea CRÍTICO y queráis su segunda opinión. El agente responde con
`DEEPSEEK — REVISIÓN` en el mismo canal, en formato MUST/SHOULD/NICE.

## Límites duros (no son solo instrucciones de prompt)

- El token de GitHub no tiene permiso de merge ni de escritura en `main`:
  aunque el modelo "quisiera" fusionar, no puede.
- El código de este repo no define ninguna función de merge, deploy o
  migración como herramienta invocable. Solo existen: leer diff/checks/
  ficheros, y comentar en la PR / publicar en Slack.
- Nunca revisa código que él mismo haya escrito (de momento no escribe
  código; si en el futuro se activa la función de "ejecución delegada",
  esa PR la deberá revisar Claude, nunca este mismo agente).

## Desarrollo local

```bash
npm install
cp .env.example .env   # y rellenar
npm run dev            # deja el proceso escuchando y sondeando cada POLL_INTERVAL_MINUTES
npm run run-once       # una sola pasada, útil para probar
```

## Despliegue en Render

El repo incluye `render.yaml` (Background Worker). En el dashboard de Render:
"New" → "Blueprint" → seleccionar este repo → rellenar como *secret* las tres
variables marcadas `sync: false` (`DEEPSEEK_API_KEY`, `SLACK_BOT_TOKEN`,
`GITHUB_TOKEN`). El resto ya viene con los valores por defecto de Fornexa.

## Qué falta (siguientes iteraciones, no bloquean el arranque)

- Pasar de sondeo por *polling* a Slack Events API (respuesta inmediata en
  vez de esperar al siguiente ciclo).
- Añadir lectura de solo-lectura de Vercel/Supabase cuando el rol lo necesite
  (hoy el agente solo mira GitHub).
- Convención de mensaje específica para el modo ÁRBITRO (que GPT incluya el
  resumen del desacuerdo con Claude en el propio handoff).
