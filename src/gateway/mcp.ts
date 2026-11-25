/**
 * MCP（Model Context Protocol）端点 —— Streamable HTTP 的**纯 POST 形态**。
 *
 * ## 支持的工具（共 7 个，全部走 `media-router.ts` 多账号容灾、401 续期与任务归属台账）
 *
 * - `web_search`：联网实时检索（含答案卡片多卡去重与相关性重排）
 * - `web_fetch`：网页正文抓取并转 Markdown（含反爬回退）
 * - `generate_image`：文生图（同步返回 COS 签名直链）
 * - `generate_video`：文生视频 / 首尾帧图生视频（异步提交返回 `task_id`，可选 `wait=true`）
 * - `get_video_task`：按 `task_id` 回到原提交账号查视频进度与直链（终态幂等记账）
 * - `generate_3d`：混元 3D 模型生成（文生/图生/多视角，`OBJ`/`GLB`/`USDZ`/`FBX`/`STL`，自动签发临时云凭证）
 * - `get_3d_task`：按 `job_id` 回到原提交账号查 3D 进度与模型文件直链（终态幂等记账）
 */
import type { Env } from '../env.js'
import { WORKBUDDY_INTL } from '../providers/buddy.js'
import { DEFAULT_PROVIDER } from '../providers/index.js'
import { INTl_IMAGE_MODEL, INTl_VIDEO_MODEL } from '../upstream/media.js'
import { redactThreeDSecrets } from '../upstream/three-d.js'
import { APP_VERSION } from '../version.js'
import {
  formatThreeDTaskPayload,
  runMediaFetch,
  runMediaImageGeneration,
  runMediaSearch,
  runMediaThreeDQuery,
  runMediaThreeDSubmit,
  runMediaVideoQuery,
  runMediaVideoSubmit,
  type MediaExecutionHooks,
} from './media-router.js'
import { recordLog } from './server.js'

/** MCP 协议版本（客户端发什么我们回什么，不认识就回最新的）。 */
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0] as string

/** JSON-RPC 错误码（规范值，不要自造）。 */
const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const

interface RpcRequest {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

/**
 * 工具清单。
 *
 * ⚠️ `description` 会被塞进模型的系统提示，必须写清「何时使用、参数边界与签名直链时效」；
 * ⚠️ `inputSchema` 必须是合法 JSON Schema（`type: 'object'` + `properties`）。
 */
const TOOLS = [
  {
    name: 'web_search',
    description:
      '联网搜索实时信息（新闻、股价、天气、最新文档等）。'
      + '当问题涉及时效性内容、或你不确定答案是否过时时使用。返回标题、链接与摘要。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，用自然语言即可' },
        max_results: {
          type: 'integer',
          description: '返回条数，默认 5，最大 20',
          minimum: 1,
          maximum: 20,
        },
        rerank: {
          type: 'boolean',
          description: '是否按相关性重排（默认 true）。搜型号/专有名词时可压制同名不同物的噪声结果。',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description:
      '抓取网页正文并转成 Markdown。用于读取用户给出的链接、或 web_search 返回的某个结果页。'
      + '不要用它抓需要登录才能看的页面。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的 http(s) 地址' },
      },
      required: ['url'],
    },
  },
  {
    name: 'generate_image',
    description:
      '根据文字描述生成图片，返回可访问的图片 URL（签名直链，约 24 小时有效，需长期保存请自行下载）。'
      + '当用户要求「画一张」「生成一张图」时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '图片描述，越具体越好' },
        size: { type: 'string', description: '尺寸如 1024x1024（默认）' },
        model: { type: 'string', description: `模型名，默认 ${INTl_IMAGE_MODEL}` },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'generate_video',
    description:
      '提交异步视频生成任务（支持文生视频与图生视频首尾帧）。'
      + '默认立即返回 task_id（通常 60–120 秒出片，随后用 get_video_task 轮询），也可设 wait=true 等待完成。'
      + '成品视频为签名直链（约 12 小时有效）。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '视频画面、镜头运动与光影描述' },
        image: { type: 'string', description: '可选首帧图：http(s) 公网 URL 或 data:image/...;base64,...' },
        last_image: { type: 'string', description: '可选尾帧图：http(s) 公网 URL 或 data:image/...;base64,...' },
        reference_images: {
          type: 'array',
          items: { type: 'string' },
          description:
            '可选参考图 URL 数组（风格/主体参考）。上游自行拉取素材，需使用其可达的公网 CDN/OSS 地址（githubusercontent 等拦截机房的域名会回 2013 media url unreachable）',
        },
        reference_videos: {
          type: 'array',
          items: { type: 'string' },
          description: '可选参考视频 URL 数组（动作/运镜参考，同样需为上游可达的公网地址）',
        },
        reference_audios: {
          type: 'array',
          items: { type: 'string' },
          description: '可选参考音频 URL 数组（配乐/音色参考，同样需为上游可达的公网地址）',
        },
        model: { type: 'string', description: `视频模型名，默认 ${INTl_VIDEO_MODEL}` },
        seconds: { type: 'integer', minimum: 1, maximum: 15, description: '时长（秒），默认 5，实测支持 4–15 秒' },
        aspect_ratio: {
          type: 'string',
          enum: ['16:9', '9:16', '1:1'],
          description: '画面比例（仅文生视频有效），默认 16:9',
        },
        resolution: { type: 'string', description: '分辨率档位（如 768P / 1080P）' },
        enable_audio: { type: 'boolean', description: '是否生成音轨（默认 true）' },
        wait: { type: 'boolean', description: '是否阻塞等待出片（默认 false 立即返回 task_id）' },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, description: 'wait=true 时的最长等待秒数（最大 600）' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'get_video_task',
    description:
      '按 generate_video 返回的 task_id 查询视频生成进度与结果 URL。'
      + '本网关自动绑定原提交账号查询，status=completed 时返回视频签名直链（约 12 小时有效）。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'generate_video 返回的任务 ID' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'generate_3d',
    description:
      '生成混元 3D 模型（异步任务）。文生 3D 传 prompt，图生 3D 传 image_url 或 image_base64，'
      + '多视角生 3D 同时传主图与 multi_view_images（勿与 prompt 同传）。'
      + '默认立即返回 job_id，用 get_3d_task 查询进度；产物支持 OBJ/GLB/USDZ/FBX/STL，直链约 24 小时有效。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '3D 物体外观、结构、材质与风格描述' },
        image_url: { type: 'string', description: '参考图公网 http(s) URL' },
        image_base64: { type: 'string', description: '参考图 base64 或 data:image/...;base64,...（解码后最大 6MiB）' },
        multi_view_images: {
          type: 'array',
          description: '多视角参考图数组，例如 [{"ViewType":"back","ViewImageUrl":"https://..."}]',
          items: { type: 'object', properties: { ViewType: { type: 'string' }, ViewImageUrl: { type: 'string' } } },
        },
        model: { type: 'string', enum: ['3.0', '3.1'], description: '模型版本，默认 3.1；LowPoly 模式必须使用 3.0' },
        enable_pbr: { type: 'boolean', description: '是否开启 PBR 物理材质贴图' },
        face_count: { type: 'integer', minimum: 10000, maximum: 1500000, description: '目标面数（10000～1500000）' },
        generate_type: {
          type: 'string',
          enum: ['Normal', 'LowPoly', 'Geometry', 'Sketch'],
          description: '生成模式；Sketch 需同时提供 prompt 与参考图',
        },
        polygon_type: { type: 'string', enum: ['triangle', 'quadrilateral'], description: '网格多边形类型' },
        result_format: {
          type: 'string',
          enum: ['OBJ', 'GLB', 'USDZ', 'FBX', 'STL'],
          description: '指定额外导出的 3D 文件格式（默认含 OBJ/GLB）',
        },
        wait: { type: 'boolean', description: '默认 false 立即返回 job_id；true 时阻塞等待至完成或超时' },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, description: 'wait=true 时的最长等待秒数（最大 600）' },
      },
    },
  },
  {
    name: 'get_3d_task',
    description:
      '按 generate_3d 返回的 job_id 查询混元 3D 任务状态与产物下载直链。'
      + 'status=DONE 时返回 GLB/OBJ 等模型文件签名直链（约 24 小时有效），未完成前请勿重复提交新任务。',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'generate_3d 返回的 job_id' },
      },
      required: ['job_id'],
    },
  },
] as const

/** 构造一条 JSON-RPC 成功响应。 */
function ok(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id, result })
}

/** 构造一条 JSON-RPC 错误响应。 */
function fail(id: unknown, code: number, message: string): Response {
  // ⚠️ 协议错误走 HTTP 200 + JSON-RPC error（规范要求），不要改成 4xx/5xx
  return Response.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
}

function logEarlyMcpValidationFailure(env: Env, name: string, startedAt: number, errorText: string): void {
  try {
    const pool = env.ACCOUNT_POOL.get(env.ACCOUNT_POOL.idFromName('global'))
    if (typeof pool.appendLog === 'function') {
      recordLog(pool, {
        type: 'mcp',
        model: `mcp:${name}`,
        provider: 'wb-router',
        uid: 'mcp',
        status: 400,
        durationMs: Math.max(0, Date.now() - startedAt),
        error: redactThreeDSecrets(errorText).slice(0, 200),
      })
    }
  } catch {
    // 审计日志失败不影响协议响应
  }
}

/**
 * 执行一次工具调用（全部接入 `media-router.ts` 的多账号容灾与幂等记账）。
 *
 * ⚠️ 执行失败返回 `isError: true` + 可读原因，而不是 JSON-RPC error。
 */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  hooks: MediaExecutionHooks = {},
): Promise<{ result: ToolResult; auditedByRouter: boolean }> {
  const text = (t: string, isError = false): ToolResult => ({
    content: [{ type: 'text', text: t }],
    ...(isError ? { isError: true } : {}),
  })

  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { result: text('参数必须是 JSON 对象', true), auditedByRouter: false }
  }

  const routerHooks: MediaExecutionHooks = { ...hooks, logType: 'mcp' }

  if (name === 'web_search') {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (query === '') return { result: text('缺少 query', true), auditedByRouter: false }
    try {
      const { result: r } = await runMediaSearch(
        env,
        {
          query,
          ...(typeof args.max_results === 'number' ? { maxResults: args.max_results } : {}),
          ...(typeof args.rerank === 'boolean' ? { rerank: args.rerank } : {}),
        },
        {
          ...routerHooks,
          targets: [{ realm: 'global', providerId: WORKBUDDY_INTL.id }],
        },
      )
      if (r.results.length === 0) {
        return { result: text(`没有找到「${query}」的结果。`), auditedByRouter: true }
      }
      const body = r.results
        .map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`)
        .join('\n\n')
      return {
        result: text(`搜索「${query}」得到 ${r.results.length} 条结果：\n\n${body}`),
        auditedByRouter: true,
      }
    } catch (error) {
      const msg = redactThreeDSecrets(error instanceof Error ? error.message : String(error))
      return { result: text(`搜索失败：${msg}`, true), auditedByRouter: true }
    }
  }

  if (name === 'web_fetch') {
    const url = typeof args.url === 'string' ? args.url.trim() : ''
    if (!/^https?:\/\//i.test(url)) {
      return { result: text('url 必须是 http(s) 地址', true), auditedByRouter: false }
    }
    try {
      const { result: r } = await runMediaFetch(
        env,
        { url },
        {
          ...routerHooks,
          targets: [{ realm: 'global', providerId: WORKBUDDY_INTL.id }],
        },
      )
      const head = r.title === '' ? `# ${r.url}` : `# ${r.title}\n\n来源：${r.url}`
      return { result: text(`${head}\n\n${r.content}`), auditedByRouter: true }
    } catch (error) {
      const msg = redactThreeDSecrets(error instanceof Error ? error.message : String(error))
      return { result: text(`抓取失败：${msg}`, true), auditedByRouter: true }
    }
  }

  if (name === 'generate_image') {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    if (prompt === '') return { result: text('缺少 prompt', true), auditedByRouter: false }
    try {
      const { result: r } = await runMediaImageGeneration(
        env,
        {
          prompt,
          ...(typeof args.size === 'string' && args.size !== '' ? { size: args.size } : {}),
          ...(typeof args.model === 'string' && args.model !== '' ? { model: args.model } : {}),
        },
        routerHooks,
      )
      if (r.images.length === 0) {
        return { result: text('上游返回成功但没有图片', true), auditedByRouter: true }
      }
      const urls = r.images.map((x, i) => `${i + 1}. ${x.url}${x.size ? `（${x.size}）` : ''}`).join('\n')
      return {
        result: text(
          `已生成 ${r.images.length} 张图片：\n\n${urls}\n\n`
            + '⚠️ 这些是签名直链（约 24 小时有效），需要长期保存请立即下载。'
            + (r.credit === undefined ? '' : `\n本次消耗 ${r.credit} 积分。`),
        ),
        auditedByRouter: true,
      }
    } catch (error) {
      const msg = redactThreeDSecrets(error instanceof Error ? error.message : String(error))
      return { result: text(`生成失败：${msg}`, true), auditedByRouter: true }
    }
  }

  if (name === 'generate_video') {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    if (prompt === '') return { result: text('缺少 prompt', true), auditedByRouter: false }

    const firstImage = typeof args.image === 'string' && args.image.trim() !== '' ? args.image.trim() : undefined
    const lastImage = typeof args.last_image === 'string' && args.last_image.trim() !== '' ? args.last_image.trim() : undefined
    for (const [field, val] of [['image', firstImage], ['last_image', lastImage]] as const) {
      if (val !== undefined && !/^(https?:\/\/|data:image\/)/i.test(val)) {
        return {
          result: text(`${field} 必须是 http(s) URL 或 data:image/...;base64,...`, true),
          auditedByRouter: false,
        }
      }
    }

    try {
      const { submitted, completedTask } = await runMediaVideoSubmit(
        env,
        {
          prompt,
          ...(typeof args.model === 'string' && args.model !== '' ? { model: args.model } : {}),
          ...(typeof args.seconds === 'number' ? { seconds: args.seconds } : {}),
          ...(typeof args.aspect_ratio === 'string' && args.aspect_ratio !== '' ? { aspectRatio: args.aspect_ratio } : {}),
          ...(typeof args.resolution === 'string' && args.resolution !== '' ? { resolution: args.resolution } : {}),
          ...(typeof args.enable_audio === 'boolean' ? { enableAudio: args.enable_audio } : {}),
          ...(firstImage === undefined ? {} : { image: firstImage }),
          ...(lastImage === undefined ? {} : { lastImage }),
          ...(args.reference_images === undefined ? {} : { referenceImages: args.reference_images }),
          ...(args.reference_videos === undefined ? {} : { referenceVideos: args.reference_videos }),
          ...(args.reference_audios === undefined ? {} : { referenceAudios: args.reference_audios }),
          ...(typeof args.wait === 'boolean' ? { wait: args.wait } : {}),
          ...(typeof args.timeout_seconds === 'number' ? { timeoutSeconds: args.timeout_seconds } : {}),
        },
        routerHooks,
      )

      if (completedTask !== undefined) {
        if (completedTask.status === 'failed') {
          return {
            result: text(
              `视频任务失败（task_id=${completedTask.taskId}）：${completedTask.error ?? '未知原因'}`,
              true,
            ),
            auditedByRouter: true,
          }
        }
        if (completedTask.status === 'completed' && completedTask.urls.length > 0) {
          const urls = completedTask.urls.map((u, i) => `${i + 1}. ${u}`).join('\n')
          return {
            result: text(
              `视频已生成完成（task_id=${completedTask.taskId}）：\n\n${urls}\n\n`
                + '⚠️ 视频是签名直链（约 12 小时有效），需要长期保存请立即下载。'
                + (completedTask.credit === undefined ? '' : `\n本次消耗 ${completedTask.credit} 积分。`),
            ),
            auditedByRouter: true,
          }
        }
      }

      const payload = {
        task_id: submitted.taskId,
        status: completedTask?.status ?? submitted.status,
        hint: '视频任务已提交（通常 60–120 秒出片）。请调用 get_video_task 传入 task_id 查询进度，不要重复提交。',
      }
      return { result: text(JSON.stringify(payload, null, 2)), auditedByRouter: true }
    } catch (error) {
      const msg = redactThreeDSecrets(error instanceof Error ? error.message : String(error))
      return { result: text(`视频提交失败：${msg}`, true), auditedByRouter: true }
    }
  }

  if (name === 'get_video_task') {
    const rawId = typeof args.task_id === 'string' && args.task_id.trim() !== ''
      ? args.task_id
      : typeof args.id === 'string' && args.id.trim() !== ''
        ? args.id
        : typeof args.video_id === 'string'
          ? args.video_id
          : ''
    const taskId = rawId.trim()
    if (taskId === '') return { result: text('缺少 task_id', true), auditedByRouter: false }

    try {
      const { task: r } = await runMediaVideoQuery(env, taskId, routerHooks)
      const payload = {
        id: r.taskId,
        task_id: r.taskId,
        object: 'video',
        status: r.status,
        ...(r.urls.length === 0 ? {} : { data: r.urls.map((u) => ({ url: u })) }),
        ...(r.durationSeconds === undefined ? {} : { seconds: r.durationSeconds }),
        ...(r.credit === undefined ? {} : { usage: { credit: r.credit } }),
        ...(r.error === undefined ? {} : { error: { message: r.error } }),
      }
      return {
        result: text(JSON.stringify(payload, null, 2), r.status === 'failed'),
        auditedByRouter: true,
      }
    } catch (error) {
      const msg = redactThreeDSecrets(error instanceof Error ? error.message : String(error))
      return { result: text(`查询视频任务失败：${msg}`, true), auditedByRouter: true }
    }
  }

  if (name === 'generate_3d') {
    try {
      const { state, model } = await runMediaThreeDSubmit(env, args, {
        ...routerHooks,
        preferredRealm: 'global',
      })
      const payload = formatThreeDTaskPayload(state.jobId, state, model, state.credit)
      return {
        result: text(JSON.stringify(payload, null, 2), state.status === 'FAIL'),
        auditedByRouter: true,
      }
    } catch (error) {
      const msg = redactThreeDSecrets(error instanceof Error ? error.message : String(error))
      // 参数校验错误发生在进路由器之前，auditedByRouter=false 由外层补一条错误日志
      const isValidation = !(msg.includes('没有可用') || msg.includes('临时云凭证') || msg.includes('3D '))
      return { result: text(`3D 生成失败：${msg}`, true), auditedByRouter: !isValidation }
    }
  }

  if (name === 'get_3d_task') {
    const rawId = typeof args.job_id === 'string' && args.job_id.trim() !== ''
      ? args.job_id
      : typeof args.id === 'string' && args.id.trim() !== ''
        ? args.id
        : typeof args.task_id === 'string'
          ? args.task_id
          : ''
    const jobId = rawId.trim()
    if (jobId === '') return { result: text('缺少 job_id', true), auditedByRouter: false }

    try {
      const { state, model, cachedCredit } = await runMediaThreeDQuery(env, jobId, {
        ...routerHooks,
        preferredRealm: 'global',
      })
      const payload = formatThreeDTaskPayload(jobId, state, model, cachedCredit)
      return {
        result: text(JSON.stringify(payload, null, 2), state.status === 'FAIL'),
        auditedByRouter: true,
      }
    } catch (error) {
      const msg = redactThreeDSecrets(error instanceof Error ? error.message : String(error))
      return { result: text(`查询 3D 任务失败：${msg}`, true), auditedByRouter: true }
    }
  }

  // 防止未引用的常量触发 lint 警告（双分片策略由 media-router 统一托管）
  void DEFAULT_PROVIDER
  return { result: text(`未知工具：${name}`, true), auditedByRouter: false }
}

/**
 * 处理一条 MCP 请求。
 *
 * @returns 响应；`undefined` 表示这是一条**通知**（无 `id`），按规范不回响应。
 */
export async function handleMcp(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
  hooks?: MediaExecutionHooks,
): Promise<Response | undefined> {
  if (request.method === 'GET') {
    // ⚠️ 规范允许客户端探测 SSE 通道；我们不提供 ⇒ 405 + Allow，客户端会退回纯 POST
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } })
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } })
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return fail(null, RPC.parseError, '请求体不是合法 JSON')
  }

  if (Array.isArray(payload)) {
    if (payload.length === 0) return fail(null, RPC.invalidRequest, '空批量')
    const first = payload[0] as RpcRequest
    return await handleOne(first, env, request.signal, ctx, hooks)
  }
  return await handleOne(payload as RpcRequest, env, request.signal, ctx, hooks)
}

async function handleOne(
  msg: RpcRequest,
  env: Env,
  signal: AbortSignal,
  ctx?: ExecutionContext,
  hooks?: MediaExecutionHooks,
): Promise<Response | undefined> {
  const id = msg.id
  const method = typeof msg.method === 'string' ? msg.method : ''
  // ⚠️ 没有 `id` 的是**通知**（如 notifications/initialized）—— 按规范不回响应
  const isNotification = id === undefined || id === null

  if (method === 'initialize') {
    const params = (msg.params ?? {}) as Record<string, unknown>
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
    return ok(id, {
      protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : LATEST_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'free-llm-router', version: APP_VERSION },
      instructions:
        '本网关提供联网检索（web_search）、网页抓取（web_fetch）、文生图（generate_image）、'
        + '异步视频生成（generate_video / get_video_task）与混元 3D 模型生成（generate_3d / get_3d_task）。'
        + '需要实时信息时优先用 web_search；视频与 3D 默认返回任务 ID，请按原 ID 轮询进度，勿重复提交。',
    })
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return undefined
  }

  if (method === 'ping') return ok(id, {})

  if (method === 'tools/list') {
    return ok(id, { tools: TOOLS })
  }

  if (method === 'tools/call') {
    const params = (msg.params ?? {}) as Record<string, unknown>
    const name = typeof params.name === 'string' ? params.name : ''
    const args = (params.arguments ?? {}) as Record<string, unknown>
    if (name === '') return fail(id, RPC.invalidParams, '缺少工具名')

    const startedAt = Date.now()
    try {
      const { result, auditedByRouter } = await callTool(name, args, env, {
        ...hooks,
        ctx,
        signal,
      })
      if (!auditedByRouter && result.isError === true) {
        const errText = result.content[0]?.text ?? '工具参数校验失败'
        logEarlyMcpValidationFailure(env, name, startedAt, errText)
      }
      return ok(id, result)
    } catch (error) {
      const errMsg = redactThreeDSecrets(error instanceof Error ? error.message : String(error))
      logEarlyMcpValidationFailure(env, name, startedAt, errMsg)
      return ok(id, {
        content: [{ type: 'text', text: `工具执行异常：${errMsg}` }],
        isError: true,
      })
    }
  }

  // 资源 / 提示词：回空清单（不是错误，避免客户端告警）
  if (method === 'resources/list') return ok(id, { resources: [] })
  if (method === 'resources/templates/list') return ok(id, { resourceTemplates: [] })
  if (method === 'prompts/list') return ok(id, { prompts: [] })

  if (isNotification) return undefined
  return fail(id, RPC.methodNotFound, `不支持的方法：${method}`)
}
