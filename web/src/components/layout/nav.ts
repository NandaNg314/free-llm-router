import {
  Activity,
  Boxes,
  ImagePlay,
  KeyRound,
  LayoutGrid,
  ListChecks,
  MessagesSquare,
  ScrollText,
  Settings2,
  type LucideIcon,
} from 'lucide-react'
import type { View } from '@/lib/router'

export interface NavItem {
  view: View
  label: string
  icon: LucideIcon
  desc: string
  keywords?: string
}

export const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: '核心运行',
    items: [
      {
        view: 'providers',
        label: '供应商与账号',
        icon: LayoutGrid,
        desc: '账号池健康度、每家供应商的账号与能力',
        keywords: 'providers accounts pool 账号池 渠道 登录',
      },
      {
        view: 'usage',
        label: '用量',
        icon: Activity,
        desc: '请求量、token 与成功率，按模型和账号拆分',
        keywords: 'usage stats tokens 统计 趋势 图表',
      },
      {
        view: 'logs',
        label: '日志',
        icon: ScrollText,
        desc: '实时请求可观测性、错误诊断抽屉与任务记录',
        keywords: 'logs requests errors trace 请求 报错 实时流',
      },
    ],
  },
  {
    group: '能力与试炼',
    items: [
      {
        view: 'playground',
        label: '对话试炼场',
        icon: MessagesSquare,
        desc: 'OpenAI 与 Anthropic 双协议流式对话、思考链路与延迟实测',
        keywords: 'playground chat stream anthropic openai 试聊 测试 对话 思考',
      },
      {
        view: 'media',
        label: '媒体与检索',
        icon: ImagePlay,
        desc: '生成图片、音视频、3D、联网搜索与网页抓取',
        keywords: 'media image video audio tts asr 3d search fetch 生图 视频 语音 搜索',
      },
      {
        view: 'tasks',
        label: '任务中心',
        icon: ListChecks,
        desc: '每日签到、成长任务与限时补偿积分',
        keywords: 'tasks checkin cron 签到 任务 积分',
      },
    ],
  },
  {
    group: '接入与系统',
    items: [
      {
        view: 'apikeys',
        label: 'API Key',
        icon: KeyRound,
        desc: '给客户端签发子密钥，可限额、限模型、限来源 IP',
        keywords: 'apikeys subkey 子密钥 令牌 限额 白名单',
      },
      {
        view: 'models',
        label: '模型',
        icon: Boxes,
        desc: '模型目录、启停、资费探测与一键试聊',
        keywords: 'models catalog probe 目录 倍率 免费 试聊',
      },
      {
        view: 'config',
        label: '配置',
        icon: Settings2,
        desc: '快速接入、路由与统一模型映射、防封错峰与跨域安全',
        keywords: 'config settings routing cors unified 路由 映射 跨域 积分锁 防封 错峰',
      },
    ],
  },
]

export const NAV_ITEMS = NAV.flatMap((g) => g.items)
