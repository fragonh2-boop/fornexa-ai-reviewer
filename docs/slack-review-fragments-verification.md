# Fragmentación correlacionada de revisiones

Checkpoint: 2026-10-05. Base verificada de `origin/main`:
`5ba2b0ef9f32dc54b007c0ebae4bde542f3b9c07`.

## Defecto y alcance

La entrega de una revisión larga añadía correlación antes de dividirla, pero
el publicador solo repetía el encabezado para respuestas conversacionales.
Las partes posteriores de una revisión perdían `SLACK_REQUEST_TS` y el ámbito
del HEAD revisado. Además, el primer fragmento podía considerarse terminal.

La corrección repite esos metadatos en cada fragmento, reserva espacio para
el sufijo y exige el índice final para reconocer un resultado terminal.
Los resultados cortos, los arrays preformateados y las respuestas
conversacionales conservan su comportamiento. Las solicitudes largas al
canal permanecen en una sola raíz; solo las revisiones correlacionadas usan
la nueva fragmentación de fallback.

El publicador en hilo ignora strings vacíos o compuestos solo por whitespace
antes de obtener el cliente Slack. Los strings con contenido mantienen su
texto exacto; los arrays preformateados conservan su semántica anterior.

Se mantiene compatibilidad con revisiones históricas: una secuencia 1..N
completa, ordenada y del mismo bot/hilo no vuelve a ejecutarse. Los
comentarios ajenos intercalados no alteran esa comprobación. Secuencias
incompletas, índices inválidos o metadatos de otra solicitud no cierran.

La recuperación legacy exige `botId` y `threadTs` coincidentes, pero no
reconstruye metadatos que el formato antiguo omitía. Una continuación sin
encabezado ni `SLACK_REQUEST_TS` no permite distinguir otra secuencia del
mismo bot/hilo si su primer fragmento falta en la captura. Es compatibilidad
heurística, no una garantía de procedencia por parte; otro bot/hilo queda
excluido. Las partes nuevas repiten la correlación explícita para evitar
depender de esa atribución legacy.

## Evidencia local verificable

Entorno: Node.js `v24.19.0`, dependencias del lockfile instaladas con
`npm ci --offline --ignore-scripts`. Sin llamadas a proveedores ni Slack:
los publicadores de las regresiones están simulados con `node:test`.

| Control | Resultado |
| --- | --- |
| `node --import tsx --test tests/slack-message-parts.test.ts` | 32/32, sin omisiones |
| `npm test` | 142/142, sin fallos ni omisiones; ejecutado fuera del sandbox solo por el IPC de tsx |
| `npm run build` | Correcto; TypeScript compila |
| `git diff --check` | Correcto |
| Revisión independiente del diff | Pendiente de renovar ambos dictámenes sobre el HEAD corregido |

Cobertura: CLAUDE/GEMINI/DEEPSEEK; éxito, rechazo y fallo; ámbitos main y PR;
TS exacto frente a prefijos y citas; límite incluyendo sufijo; cuerpo y orden;
recuperación legacy; solicitud larga intacta; fallback; fallo de publicación
intermedia; cierre solo en parte final; arrays sin doble fragmentación.
Las cinco regresiones adicionales cubren strings vacíos/whitespace, texto
corto exacto, arrays intactos, TS moderno ajeno del mismo bot/hilo y el límite
legacy explícito: sin metadatos puede cerrar una continuación ajena.

La CI del repositorio ejecuta `npm ci`, `npm test` y `npm run build` en Node.js
22. Su resultado debe comprobarse sobre el HEAD exacto de la PR.

## Estado y siguiente gate

Implementado y verificado localmente; pendiente de integración y despliegue.
No se modificaron tokens, configuración de producción, BBDD ni el repositorio
de producto. Esta evidencia local no demuestra entrega real del código nuevo.

Después de integrar y desplegar bajo los gates correspondientes, solicitar
una revisión larga de un HEAD fijo y comprobar en Slack: recepción, todas las
partes en el hilo correcto con el mismo `SLACK_REQUEST_TS`/HEAD/ámbito,
numeración 1..N completa, resultado terminal final y ausencia de duplicados
tras el sondeo. Solo entonces puede cerrarse la verificación en producción.
