// Porta de entrada pública (direct.serviços.site) → túnel → web:3000 na VPS.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-proto", "https");
    return env.ORIGEM.fetch(
      new Request("http://web:3000" + url.pathname + url.search, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
      })
    );
  },
};
