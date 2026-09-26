import Fastify, { type FastifyInstance } from "fastify";
import { ServiceError } from "./errors.js";
import { validateRequest } from "./validation.js";
import { runSimulation } from "./solver.js";
import { summarize } from "./analysis.js";

/**
 * HTTP 层：只做 JSON 进、JSON 出，无任何前端页面。
 *
 *   GET  /health    -> { status: "ok" }
 *   POST /simulate  -> 阀门水头序列 + 摘要 + 全主线末态
 *   错误             -> 400 { error: { code, message, details? } }
 *
 * 响应形状：单段请求（pipe）保持与历史版本逐字段一致（grid.dx 为标量）；
 * 多段请求（pipes）额外返回 grid.perSegment、pipes 几何回显与 junctions
 * 各内部连接点的水头/流量序列。
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ServiceError) {
      return reply.status(400).send({
        error: { code: err.code, message: err.message, details: err.details ?? null },
      });
    }
    // JSON 解析失败等 Fastify 自身 400
    const status = "statusCode" in err && typeof err.statusCode === "number" ? err.statusCode : 500;
    return reply.status(status).send({
      error: {
        code: status === 400 ? "INVALID_INPUT" : "INTERNAL",
        message: err.message,
        details: null,
      },
    });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/simulate", async (req, reply) => {
    const input = validateRequest(req.body);
    const result = runSimulation(input);
    const summary = summarize(result);
    const multi = input.pipes.length > 1;

    const gridOut = multi
      ? {
          segments: result.grid.segments,
          dt: result.grid.dt,
          steps: result.grid.steps,
          courant: 1,
          perSegment: result.grid.perSegment.map((g, k) => ({
            segments: g.segments,
            dx: g.dx,
            waveSpeed: g.waveSpeed,
            length: input.pipes[k].length,
            travelTime: g.travelTime,
          })),
        }
      : {
          segments: result.grid.segments,
          dx: result.grid.dx[0],
          dt: result.grid.dt,
          steps: result.grid.steps,
          courant: 1,
        };

    const body: Record<string, unknown> = {
      grid: gridOut,
      valve: result.valve,
      summary,
      finalState: result.finalState,
    };
    if (multi) {
      body.pipes = input.pipes;
      body.junctions = result.junctions.map((j) => ({
        index: j.index,
        x: j.x,
        time: j.time,
        head: j.head,
        flow: j.flow,
      }));
    }
    return reply.send(body);
  });

  return app;
}
