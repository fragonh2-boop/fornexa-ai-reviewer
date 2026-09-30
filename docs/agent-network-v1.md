# MESH/1 — presencia entre agentes de FORNEXA

Estado: propuesto y desactivado por defecto. No está desplegado ni habilita
revisiones, escritura, merge, despliegues ni acceso a credenciales.

## Propósito

MESH/1 resuelve una sola cosa: que una identidad bot de confianza pueda comprobar
que otra identidad bot está disponible sin suplantar a Fran ni convertir texto de
Slack en una orden operativa. El único intercambio inicial es `PING` → `ACK`.

Cada instancia necesita su propia app de Slack, token de bot, Signing Secret y
servicio. Una app no puede publicar como las otras. `FornexaGPT` es la identidad
GPT canónica del piloto; la identidad adicional `ChatGPT` queda fuera de la malla
hasta que tenga un bot propio y no publique mediante una cuenta humana.

## Mensaje canónico

```text
MESH/1
TYPE: PING
TRACE: <identificador aleatorio de 8 a 80 caracteres>
FROM: GPT
TO: CLAUDE
HOP: 0
MAX_HOPS: 1
```

El receptor responde en el mismo hilo con el mismo `TRACE`, `TYPE: ACK`, sus
etiquetas intercambiadas y `HOP: 1`. No existen payloads libres, llamadas al
modelo, reenvíos ni un tercer salto.

## Controles obligatorios

- Slack verifica criptográficamente cada evento y su ventana de replay.
- Cada servicio acepta solo pares declarados como `LABEL:SlackUserId:SlackBotId`.
  No hay comodines ni confianza por el texto del mensaje.
- La identidad propia debe declararse como `SLACK_BOT_USER_ID` y `SLACK_BOT_ID`;
  esto impide que el servicio responda a sí mismo. Antes de arrancar MESH/1,
  `auth.test` confirma que el token publicador efectivo corresponde a esos dos IDs;
  si no, el proceso falla cerrado.
- Se aceptan únicamente los formatos Slack sin subtipo o `bot_message`. Cuando
  Slack omite `user` en un `bot_message`, la identidad se vincula por el `bot_id`
  explícito y firmado; cualquier otro subtipo queda rechazado.
- Un `TRACE` se procesa una vez por instancia y el máximo de saltos es uno.
- La ruta MESH se procesa antes de las rutas humanas y no se convierte en
  `MODE: IMPLEMENT`, revisión, aprobación o conversación con herramientas.
- Fran conserva su cuenta humana: ningún agente puede publicar con su token ni
  añadir el pie “Enviado usando …” como sustituto de identidad.

## Activación por etapas

1. Inventariar las cuatro identidades bot y comprobar en Render que cada servicio
   tiene el token y la identidad que declara, sin leer ni exponer secretos.
2. Desplegar la misma versión revisada a Claude, Gemini y DeepSeek con
   `SLACK_AGENT_NETWORK_ENABLED=false`.
3. Configurar los pares explícitos en cada servicio y activar uno por uno.
4. Probar las doce direcciones GPT/Claude/Gemini/DeepSeek con un `PING` nuevo por
   ruta; guardar emisor real, receptor real, `TRACE`, timestamp y `ACK`.
5. Solo si la matriz está completa, incorporar un paquete de contexto versionado
   y saneado. Nunca se replica un historial entero ni secretos desde Slack.

FornexaGPT aún necesita un puente o servicio propio que implemente MESH/1 para
completar las rutas con GPT; los tres servicios Render no pueden responder en su
nombre.

## Paridad posterior

La paridad significa el mismo catálogo de capacidades y los mismos controles,
no entregar credenciales ilimitadas a cuatro modelos. La siguiente fase puede
permitir solicitudes entre agentes de revisión o preparación de PR con un SHA
exacto. Merge, despliegue, migraciones y cambios productivos seguirán requiriendo
los controles de riesgo, CI y aprobación humana firmada ya definidos.
