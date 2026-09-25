# Relay UI image prompts

These are the explicit built-in imagegen prompts used to extend the existing relay reference sheet. The first image remains the shared visual source. Each prompt describes a different page so no page is generated twice.

## Shared visual language

- Match the original OpenMyModel relay reference: deep teal-green fixed sidebar, pale mint page canvas, white rounded cards, emerald active and success states, soft gray borders, restrained line icons, clean Chinese typography, generous spacing.
- Use crisp flat desktop dashboard screenshots with realistic alignment and readable labels.
- Treat the generated images as layout references only. Keep production wording and live values in the application.
- One page per image; no collages or duplicated page content.

## Model aliases and personal node routes

Use case: ui-mockup
Asset type: one production-quality desktop web dashboard page for the OpenMyModel relay console
Input images: Image 1: exact visual-style reference only; match its OpenMyModel dark teal-green sidebar, pale mint page background, white rounded cards, emerald accents, restrained line icons, typography, and generous spacing. Do not reproduce any of Image 1's page content.
Primary request: design one complete "模型与路由" account-console page that lets a user publish model aliases and route each alias only to their own inference nodes.
Scene/backdrop: clean SaaS admin dashboard in a desktop browser, 1440x1000 viewport, crisp flat UI screenshot, no browser chrome.
Subject: the model and route management page, with a fixed dark deep-teal sidebar on the left (about 230 px), a slim white top bar, and a wide content column.
Style/medium: polished realistic web-product UI mockup, consistent with Image 1's OpenMyModel visual identity.
Composition/framing: sidebar navigation items exactly "概览", "我的节点", "API 密钥", "使用记录", "转发订阅", "模型与路由" (active); top bar shows "OpenMyModel" and a small user avatar. Main page heading exactly "模型与路由" and subtitle "为你的节点设置公开模型别名与调度路由". Show a pale-green info banner that says "请求仅转发到你自己的节点；平台不提供共享算力，也不按 Token 计价". Below, a compact white card titled "创建公开模型别名" with labeled inputs "公开模型别名" and "模型备注", plus an emerald "保存模型" button. Below that, one large white model card for alias "qwen-home" with a small "已启用" status chip and note "家用推理节点". In the card show two separate node routes, each with node name, actual upstream model, weight and availability: "工作站 A" → "Qwen2.5-14B-Instruct-Q4_K_M" weight 2 "在线 · 就绪"; "工作站 B" → "Qwen2.5-14B-Instruct" weight 1 "在线 · 就绪". Add an "＋ 添加路由" control with a node dropdown, actual-model input, and weight control. Make route availability and the public-to-upstream name mapping visually obvious.
Lighting/mood: precise, quiet, trustworthy, operational; no glossy gradients.
Color palette: use Image 1's dark teal (#123f3c approximate), pale mint background, warm white cards, emerald green active states, soft gray borders, muted gray body text.
Materials/textures: flat vector-like interface surfaces with subtle 1 px borders and very soft shadows only.
Text (verbatim): use the exact Chinese labels and model strings listed above; render them cleanly and legibly without extra paragraphs.
Constraints: exactly one screen and one distinct page; preserve clear visual hierarchy, aligned fields, accessible contrast, realistic table/card spacing, no duplicated navigation, no billing prices, no other users' nodes.
Avoid: collage, multi-screen montage, dark main canvas, neon, excessive gradients, marketing hero art, logos other than the small OpenMyModel app label, unreadable placeholder gibberish, watermark.

Saved reference: [relay-model-routing-reference.png](relay-model-routing-reference.png)

## Administrator user support

Use case: ui-mockup
Asset type: one production-quality desktop web admin dashboard page for the OpenMyModel relay service desk
Input images: Image 1: visual-style reference only; match its deep teal-green left sidebar, pale mint canvas, white rounded cards, emerald state chips, subtle gray borders, restrained icons, clean Chinese typography and spacing. Do not reuse its model-routing content.
Primary request: design one complete administrator "用户管理" support page for a relay-only model gateway, where staff can inspect account status, usage and nodes, then suspend or restore an account.
Scene/backdrop: desktop SaaS administration page, 1440x1000 viewport, crisp flat UI screenshot with no browser chrome.
Subject: administrator user support list for accounts that own their own model nodes; no platform-shared compute pool.
Style/medium: polished realistic web-product UI mockup; consistent with Image 1's OpenMyModel identity.
Composition/framing: fixed 230 px dark teal sidebar with "OpenMyModel" brand and exact navigation labels "概览", "节点管理", "用户管理" (active), "API 密钥", "使用统计", "订单", "系统设置"; slim white top header with "管理员" and small avatar. Main content heading exactly "用户管理", subtitle "查看账户状态、节点接入、API 密钥与转发用量". Top row contains three compact metric cards: "注册用户" value "128", "在线节点" value "34", "本月转发请求" value "18,420". Add a white table card titled "账户列表" with a search field "搜索邮箱" and status filter "全部状态". The table has exactly these columns: "邮箱", "节点（在线/总数）", "API Key", "累计 Token", "订阅到期", "状态", "操作". Show exactly three realistic masked example email rows: "li***@example.com", "zh***@mail.com", "wa***@example.net"; node counts "2 / 3", "1 / 1", "0 / 2"; key counts "2", "1", "1"; token counts "2.4M", "846K", "112K"; expiry dates "2026-10-12", "2026-10-03", "—"; status chips "正常", "正常", "已停用". Each row has two compact actions exactly "查看用量" and either "停用账户" or "恢复账户" depending on status. Keep table columns aligned, legible and calm.
Lighting/mood: trustworthy, precise, neutral service operations.
Color palette: inherit Image 1: dark teal, soft mint, warm white, emerald highlights, muted slate text, discreet amber or red only for disabled/danger states.
Materials/textures: flat UI surfaces, subtle 1 px outlines and soft shadow only.
Text (verbatim): all specified Chinese navigation, headings, columns, masked emails, dates, counts and buttons must appear exactly; no extra explanatory copy.
Constraints: one screen, one distinct page; no billing balances, no shared model pool, no payment form, no customer chat widget, no sensitive full email addresses, no excessive density.
Avoid: multi-screen collage, charts, marketing hero, black/dark main canvas, neon, overdecorated gradients, unreadable filler text, watermarks.

Saved reference: [relay-admin-users-reference.png](relay-admin-users-reference.png)
