const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response(Bun.file(new URL("./index.html", import.meta.url)));
    if (path === "/app.js") {
      const result = await Bun.build({
        entrypoints: [new URL("./app.ts", import.meta.url).pathname],
        target: "browser",
      });
      if (!result.success) {
        console.error(result.logs);
        return new Response("Browser build failed; see terminal.", { status: 500 });
      }
      return new Response(result.outputs[0], {
        headers: { "Content-Type": "text/javascript", "Cache-Control": "no-store" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
});
console.log(`Order playground: ${server.url}`);
