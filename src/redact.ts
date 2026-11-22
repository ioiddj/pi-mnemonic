export const MAX_COMMAND_CHARS = 500;

export function redactCommand(command: string): string {
	let out = String(command ?? "").replace(/\s+/g, " ").trim();
	out = out.replace(/(--(?:token|password|passwd|secret|api[_-]?key))(?:[=\s]+)(?:"[^"]*"|'[^']*'|[^\s'"]+)/gi, "$1=<redacted>");
	out = out.replace(/(-[A-Za-z]*(?:token|password|secret|key))(?:[=\s]+)([^\s'"]+)/gi, "$1=<redacted>");
	out = out.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "<redacted-auth>");
	out = out.replace(/\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET))\s*=\s*(?:"[^"]*"|'[^']*'|[^\s&;,}]+)/gi, "$1=<redacted>");
	out = out.replace(/https?:\/\/[^/\s:]+:[^@\s]+@/gi, "$<redacted-userinfo>@");
	out = out.replace(/\{\{secret:[^}]+\}\}/gi, "{{secret:<redacted>}}");
	if (out.length > MAX_COMMAND_CHARS) out = `${out.slice(0, MAX_COMMAND_CHARS - 1)}…`;
	return out;
}
