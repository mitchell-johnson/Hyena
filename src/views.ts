import { escapeHtml } from './http'

export function page(title: string, content: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Hyena</title><style>
  :root{color-scheme:light dark;font-family:system-ui,sans-serif;background:#11151d;color:#edf1fa}*{box-sizing:border-box}body{margin:0;padding:clamp(20px,5vw,64px);line-height:1.55}main{max-width:560px;margin:5vh auto}h1{font-size:clamp(28px,7vw,40px);line-height:1.15}a{color:#b8c6ff}label{display:block;margin:20px 0 6px;font-weight:600}input,textarea,button{font:inherit;width:100%;padding:12px;border:1px solid #41495e;border-radius:8px}input,textarea{background:#1a2130;color:inherit}button{background:#c4ceff;color:#131a32;border:0;font-weight:700;margin-top:24px;cursor:pointer}small,.muted{color:#adb7cb}code{overflow-wrap:anywhere}nav{display:flex;gap:20px;margin:24px 0}.error{border-left:3px solid #ffa58c;padding:12px;color:#ffd0c3}.brand{font-weight:700;letter-spacing:.06em}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><main><a class="brand" href="/">HYENA</a>${content}</main></body></html>`
}
export function hidden(name: string, value: string): string {
	return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`
}
