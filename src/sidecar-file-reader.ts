import fs from "node:fs/promises";
import path from "node:path";
import { containsPotentialSecret } from "./context-onboarding.js";
import { isSafeSidecarReadPath } from "./local-sidecar-policy.js";

const MAX_FILE_BYTES = 15_000;

export async function readSafeSidecarFile(
  workspaceDir: string,
  relativePath: string
): Promise<string> {
  if (!isSafeSidecarReadPath(relativePath)) {
    return "Error de seguridad: no se permite leer esa ruta o tipo de fichero.";
  }
  const resolved = path.resolve(workspaceDir, relativePath);
  if (resolved !== workspaceDir && !resolved.startsWith(workspaceDir + path.sep)) {
    return "Error de seguridad: la ruta solicitada está fuera del espacio de trabajo permitido.";
  }
  try {
    const [realWorkspace, realResolved, directStat] = await Promise.all([
      fs.realpath(workspaceDir), fs.realpath(resolved), fs.lstat(resolved),
    ]);
    if (directStat.isSymbolicLink() ||
        (realResolved !== realWorkspace && !realResolved.startsWith(realWorkspace + path.sep))) {
      return "Error de seguridad: no se permiten enlaces simbólicos ni rutas reales fuera del espacio de trabajo.";
    }
    const realRelative = path.relative(realWorkspace, realResolved).split(path.sep).join("/");
    if (!isSafeSidecarReadPath(realRelative)) {
      return "Error de seguridad: la ruta real no pertenece a la lista de lectura permitida.";
    }
    const stat = await fs.stat(realResolved);
    if (!stat.isFile()) return `Error: "${relativePath}" no es un fichero regular.`;
    if (stat.size > MAX_FILE_BYTES) {
      return `Error: "${relativePath}" supera el límite de lectura de ${MAX_FILE_BYTES} bytes.`;
    }
    const content = await fs.readFile(realResolved, "utf8");
    if (containsPotentialSecret(content) ||
        /(?:api[_-]?key|password|passwd|secret|token)\s*[:=]\s*["']?[^\s"']{8,}/i.test(content)) {
      return "Error de seguridad: el contenido parece incluir una credencial y no se devolverá.";
    }
    return `Contenido de ${relativePath} (${content.length} bytes):\n${content}`;
  } catch (error) {
    return `No se pudo leer el fichero ${relativePath}: ${(error as Error).message}`;
  }
}
