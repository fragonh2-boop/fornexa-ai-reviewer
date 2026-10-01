# Bridge dedicado de FornexaGPT

Este proceso conecta la identidad Slack **FornexaGPT** con MESH/1. No carga un
modelo, no recibe contexto de desarrollo y no tiene token ni rutas de GitHub,
merge, despliegue o implementación. Su único comportamiento es responder
`PING` válido con `ACK`, o emitir un `PING` canónico contra un par declarado.

## Arranque seguro

Se construye junto con el repositorio y se ejecuta con:

```bash
npm run start:gpt-bridge
```

Mientras `SLACK_AGENT_NETWORK_ENABLED=false` (el valor por defecto), solo
expone salud y devuelve 503 para Slack y MESH. Para activarlo hacen falta todos
estos secretos/configuraciones en un servicio Render **nuevo y dedicado**:

```text
SLACK_AGENT_NETWORK_ENABLED=true
SLACK_AGENT_LABEL=GPT
SLACK_BOT_TOKEN=<token xoxb exclusivo de FornexaGPT>
SLACK_SIGNING_SECRET=<signing secret de la app FornexaGPT>
SLACK_BOT_USER_ID=<U… de FornexaGPT>
SLACK_BOT_ID=<B… de FornexaGPT>
SLACK_CHANNEL_ID=C0BT661FYLW
SLACK_AGENT_NETWORK_PEERS=CLAUDE:U…:B…,GEMINI:U…:B…,DEEPSEEK:U…:B…
MESH_CONTROL_TOKEN=<secreto aleatorio exclusivo del bridge>
```

No se reutilizan tokens humanos ni de Claude, Gemini o DeepSeek. Al arrancar,
el bridge ejecuta `auth.test`; si el token publicador no corresponde a los IDs
declarados, termina sin abrir el puerto.

## Rutas

- `GET /`: salud; no revela secretos.
- `POST /slack/events`: verifica firma y acepta exclusivamente MESH/1 de un
  peer explícito. Slack reintentará si no se puede publicar el ACK.
- `POST /mesh/ping`: exige `Authorization: Bearer <MESH_CONTROL_TOKEN>` y un
  JSON limitado a `{ "to": "CLAUDE" | "GEMINI" | "DEEPSEEK" }`. No admite
  texto libre ni operaciones distintas de PING. Solo admite un PING pendiente
  por par y aplica un intervalo mínimo de un minuto por destino (429 si se
  excede; 422 si el destino no está declarado).
- `GET /mesh/status`: exige el mismo bearer y devuelve solo el número de PINGs
  pendientes, que caducan a los quince minutos.

Configura en la app de Slack `message.channels` con la URL
`https://<bridge>.onrender.com/slack/events` y no subscribas al bridge a rutas
operativas. Después de desplegar y validar la identidad, la activación debe ser
por pares y registrar para cada ruta el `TRACE`, ambos bots y el ACK. El bridge
no prueba ni habilita por sí mismo las doce rutas.

## Render y secreto de control

`render.yaml` declara `fornexa-gpt-bridge` sobre la rama `main`, con despliegue
automático desactivado y MESH inerte. Al provisionarlo, introduce
`MESH_CONTROL_TOKEN` desde el gestor de secretos autorizado y entrégalo solo al
controlador que vaya a invocar `/mesh/ping`; no se puede reconstruir desde el
repositorio ni desde los logs. Para rotarlo, genera un valor nuevo fuera de Git,
reemplázalo en Render, reinicia el servicio y revoca el anterior.

El plan `free` sirve para preparar el servicio, pero puede dormir y retrasar la
respuesta a Slack. Antes de activar una malla con expectativa 24/7, mueve el
bridge a un plan always-on y registra la ventana de mantenimiento o el rollback.
