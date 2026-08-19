import { STARTING_DEFAULTS } from "@/lib/assumptions";
import { streamExplanation } from "@/lib/explain";
import { runEstimate } from "@/lib/pipeline";

/**
 * 估算接口。
 *
 * ⚠️ 这是**服务器端**代码。API key 从 process.env 读,永远不会到浏览器。
 *    不要把这里的逻辑挪到客户端组件里。
 *
 * 响应格式是 NDJSON(每行一个 JSON),一次往返里先发数字后发文字:
 *
 *   {"type":"estimate", ...}     ← 第一行:完整的确定性估算结果
 *   {"type":"text","delta":"…"}  ← 后续:Layer 3 的解释,逐块流出
 *   {"type":"done"}
 *
 * 为什么不拆成两个接口:数字要是先返回给浏览器、再由浏览器发回来求解释,
 * 客户端就有机会篡改金额。一次往返里搞定,金额从不离开服务器的控制。
 */

export const runtime = "nodejs";
/** 流式响应可能跑几十秒,Vercel 默认 10s 会截断 */
export const maxDuration = 300;

export async function POST(req: Request) {
  let rfpText: string;
  try {
    const body = await req.json();
    rfpText = String(body.rfpText ?? "").trim();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  if (rfpText.length < 50) {
    return Response.json(
      { error: "招标文件内容太短,至少需要 50 个字符" },
      { status: 400 },
    );
  }
  if (rfpText.length > 500_000) {
    return Response.json(
      { error: "内容过长。请只粘贴工作范围 (Scope of Work) 章节,或分段处理。" },
      { status: 413 },
    );
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    // 配置问题不要泄漏细节给客户端,日志里留痕就够了
    console.error("ANTHROPIC_API_KEY 未配置");
    return Response.json({ error: "服务暂时不可用" }, { status: 503 });
  }

  const encoder = new TextEncoder();
  const line = (obj: unknown) => encoder.encode(JSON.stringify(obj) + "\n");

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // ── Layer 1 + Layer 2 ──
        // 生产环境要把 assumptions 换成当前登录客户的假设库,
        // 并去掉 useFixtureWages、传入真实的 samApiKey。
        const { snapshot, comparablesCaveat, pipelineWarnings } = await runEstimate({
          rfpText,
          assumptions: STARTING_DEFAULTS,
          id: crypto.randomUUID(),
          now: new Date().toISOString(),
          useFixtureWages: true, // ⚠️ 上线前改成 false 并配置 samApiKey
          samApiKey: process.env.SAM_GOV_API_KEY,
          blsApiKey: process.env.BLS_API_KEY,
        });

        // 数字先走,前端可以立刻渲染表格,不用等解释生成完
        controller.enqueue(
          line({ type: "estimate", snapshot, comparablesCaveat, pipelineWarnings }),
        );

        // ── Layer 3 ──
        for await (const chunk of streamExplanation(
          snapshot.scope,
          snapshot.estimate,
          STARTING_DEFAULTS,
          comparablesCaveat,
        )) {
          controller.enqueue(line({ type: "text", delta: chunk }));
        }

        controller.enqueue(line({ type: "done" }));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("估算失败:", e);
        // 已经开始流了就没法改 HTTP 状态码,只能在流里发错误
        controller.enqueue(line({ type: "error", message }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      // 有些反代会缓冲流式响应,这个头让 nginx 别缓冲
      "X-Accel-Buffering": "no",
    },
  });
}
