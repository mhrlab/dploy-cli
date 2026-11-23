export interface EnvParseResult {
    lines: string[];
    entries: Map<string, string>;
}

export function parseEnvContent(content: string): EnvParseResult {
    const lines = content.split(/\r?\n/);
    const entries = new Map<string, string>();

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        const eqIdx = line.indexOf("=");
        if (eqIdx !== -1) {
            const key = line.slice(0, eqIdx).trim();
            const val = line.slice(eqIdx + 1).trim();
            if (key) {
                entries.set(key, val);
            }
        }
    }

    return { lines, entries };
}

export function updateOrAppendEnv(content: string, key: string, value: string): string {
    const lines = content.split(/\r?\n/);
    let found = false;

    const updatedLines = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;

        const eqIdx = line.indexOf("=");
        if (eqIdx !== -1) {
            const currentKey = line.slice(0, eqIdx).trim();
            if (currentKey === key) {
                found = true;
                return `${key}=${value}`;
            }
        }
        return line;
    });

    if (!found) {
        if (updatedLines.length > 0 && updatedLines[updatedLines.length - 1].trim() !== "") {
            updatedLines.push(`${key}=${value}`);
        } else {
            updatedLines.push(`${key}=${value}`);
        }
    }

    return updatedLines.join("\n");
}
