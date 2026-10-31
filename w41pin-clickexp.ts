// Does WebKit drop the click of a trusted mousedown + mouseup on a fixed button while rows arrive?
import { webkit, chromium } from "playwright-core";
const engine = process.env.ENGINE === "chromium" ? chromium : webkit;
const N = Number(process.env.N ?? 150);
const html = `<!doctype html><style>
main{height:400px;overflow-y:auto;scroll-behavior:smooth;display:flex;flex-direction:column}
.row{padding:4px}
.anim .row.new{animation:rise .35s ease-out}
@keyframes rise{from{opacity:0;transform:translateY(6px)}}
#jump{position:fixed;left:50%;bottom:26px;transform:translateX(-50%)}
</style><body><main id="s"><div id="lines"></div></main><button id="jump">Back</button></body>`;
const browser = await engine.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
await page.setContent(html);
for (const variant of (process.env.VARIANTS ?? "none,append,anim").split(",")) {
  let lost = 0;
  for (let i = 0; i < N; i++) {
    await page.evaluate((v) => {
      const w = window as any;
      document.body.className = v === "anim" ? "anim" : "";
      w.ev = [];
      w.clicks = 0;
      if (!w.wired) {
        w.wired = true;
        for (const t of ["mousedown", "mouseup", "click"]) window.addEventListener(t, (e) => w.ev.push(e.type), true);
        document.getElementById("jump")!.addEventListener("click", () => w.clicks++);
      }
      clearInterval(w.timer);
      if (v !== "none") {
        let k = 0;
        w.timer = setInterval(() => {
          const r = document.createElement("div");
          r.className = "row new";
          r.textContent = "a long sentence that keeps going ".repeat(12) + k++;
          document.getElementById("lines")!.append(r);
          setTimeout(() => r.classList.remove("new"), 1000);
        }, 20);
      }
    }, variant);
    await page.waitForTimeout(30 + (i % 7) * 7);
    await page.click("#jump");
    await page.waitForTimeout(60);
    const r = await page.evaluate(() => ({ ev: (window as any).ev.join(","), clicks: (window as any).clicks }));
    if (r.clicks !== 1) {
      lost++;
      if (lost <= 3) console.log(variant, i, JSON.stringify(r));
    }
  }
  await page.evaluate(() => clearInterval((window as any).timer));
  console.log(`RESULT ${engine.name()} ${variant}: lost ${lost} of ${N}`);
}
await browser.close();
