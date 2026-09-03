import path from 'node:path';

function splitShellWords(segment: string): string[] {
    const words: string[] = [];
    let current = '';
    let quote: "'" | '"' | null = null;
    let escaped = false;

    const push = () => {
        if (current.length > 0) {
            words.push(current);
            current = '';
        }
    };

    for (let i = 0; i < segment.length; i++) {
        const char = segment[i];

        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }

        if (char === '\\' && quote !== "'") {
            escaped = true;
            continue;
        }

        if (quote) {
            if (char === quote) {
                quote = null;
            } else {
                current += char;
            }
            continue;
        }

        if (char === "'" || char === '"') {
            quote = char;
            continue;
        }

        if (/\s/.test(char)) {
            push();
            continue;
        }

        current += char;
    }

    push();
    return words;
}

function normalizeExecutable(token: string): string {
    const unquoted = token.replace(/^["']|["']$/g, '');
    const base = path.win32.basename(path.posix.basename(unquoted));
    return base.replace(/\.exe$/i, '').toLowerCase();
}

function normalizeTokens(segment: string): string[] {
    const words = splitShellWords(segment);
    let firstExecutable = 0;

    while (
        firstExecutable < words.length &&
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[firstExecutable])
    ) {
        firstExecutable++;
    }

    if (firstExecutable >= words.length) {
        return [];
    }

    const normalized = words.slice(firstExecutable).map((word) => word.toLowerCase());
    normalized[0] = normalizeExecutable(words[firstExecutable]);
    return normalized;
}

function extractShellSegments(command: string): string[] {
    const segments: string[] = [];
    let current = '';
    let quote: "'" | '"' | null = null;
    let escaped = false;

    const push = () => {
        const value = current.trim();
        if (value) segments.push(value);
        current = '';
    };

    for (let i = 0; i < command.length; i++) {
        const char = command[i];

        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }

        if (char === '\\') {
            escaped = true;
            current += char;
            continue;
        }

        // Command substitutions execute even inside double quotes.
        if (char === '$' && command[i + 1] === '(' && quote !== "'") {
            let depth = 1;
            let j = i + 2;
            let innerQuote: "'" | '"' | null = null;
            while (j < command.length && depth > 0) {
                const inner = command[j];
                if (innerQuote) {
                    if (inner === innerQuote && command[j - 1] !== '\\') {
                        innerQuote = null;
                    }
                } else if (inner === "'" || inner === '"') {
                    innerQuote = inner;
                } else if (inner === '(') {
                    depth++;
                } else if (inner === ')') {
                    depth--;
                }
                j++;
            }
            if (depth === 0) {
                segments.push(...extractShellSegments(command.slice(i + 2, j - 1)));
                current += command.slice(i, j);
                i = j - 1;
                continue;
            }
        }

        if (char === '`' && quote !== "'") {
            const close = command.indexOf('`', i + 1);
            if (close !== -1) {
                segments.push(...extractShellSegments(command.slice(i + 1, close)));
                current += command.slice(i, close + 1);
                i = close;
                continue;
            }
        }

        if (quote) {
            if (char === quote) quote = null;
            current += char;
            continue;
        }

        if (char === "'" || char === '"') {
            quote = char;
            current += char;
            continue;
        }

        if (char === '(') {
            let depth = 1;
            let j = i + 1;
            while (j < command.length && depth > 0) {
                if (command[j] === '(') depth++;
                if (command[j] === ')') depth--;
                j++;
            }
            if (depth === 0) {
                segments.push(...extractShellSegments(command.slice(i + 1, j - 1)));
                current += command.slice(i, j);
                i = j - 1;
                continue;
            }
        }

        const two = command.slice(i, i + 2);
        if (two === '&&' || two === '||') {
            push();
            i++;
            continue;
        }

        if (char === ';' || char === '|' || char === '&' || char === '\n') {
            push();
            continue;
        }

        current += char;
    }

    push();
    return segments;
}

export function normalizeCommandPrefix(prefix: string): string {
    const tokens = normalizeTokens(prefix.trim());
    if (tokens.length === 0) {
        throw new Error('Command prefix must contain an executable');
    }
    return tokens.join(' ');
}

export function commandMatchesPrefix(command: string, prefix: string): boolean {
    const expected = normalizeCommandPrefix(prefix).split(' ');

    for (const segment of extractShellSegments(command)) {
        const actual = normalizeTokens(segment);
        if (actual.length < expected.length) continue;

        let matches = true;
        for (let i = 0; i < expected.length; i++) {
            if (actual[i] !== expected[i]) {
                matches = false;
                break;
            }
        }
        if (matches) return true;
    }

    return false;
}
