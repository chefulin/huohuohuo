# 我现在火气很大 — 项目全文件索引与开发指引（最终版）

## 一、项目概述
移动端H5匿名社交小游戏。好友间单击/长按头像互动产生火气值与包容值变化。
纯前端+LocalStorage，无后端。

## 二、技术栈
HTML5 + CSS3 + 原生JavaScript + LocalStorage + Canvas API
移动端适配 375-414px，支持微信/Safari/Chrome移动版

## 三、目录结构
```
huoqi-h5/
├── logs/
│   └── 2026-06-03.md
├── docs/
│   ├── requirements.md
│   ├── ui-design-spec.md
│   ├── dev-plan.md
│   └── data-config.md
├── src/
│   ├── login.html          # 注册+登录
│   ├── friend.html          # 好友主页（头像分页+击打/安抚+聊天入口）
│   ├── chat.html            # 一对一私聊
│   ├── rank.html            # 双排行榜（火气榜+包容榜）
│   ├── recommend.html       # 全平台周度推荐榜
│   ├── shop.html            # 包容值商城（7款头像框）
│   ├── share.html           # 二维码生成分享
│   └── js/
│       └── data.js          # 全局数据层
└── Cloud.md
```

## 四、页面间跳转关系
```
login.html ──登录成功──→ friend.html
friend.html ──点💬──→ chat.html?friend=xxx
friend.html ──点排行榜──→ rank.html
friend.html ──点商城──→ shop.html
friend.html ──点推荐──→ recommend.html
friend.html ──点分享──→ share.html
各子页面 ──点←──→ 返回上一页
```

## 五、核心数值规则速查
| 操作 | 效果 |
|------|------|
| 单击好友头像 | 对方火气+1，自己包容+1（自己火气≥999时强制变安抚）|
| 长按好友头像 | 对方火气-1（最低0），自己包容+1 |
| 包容≥999 | 解锁商城，可兑换7款头像框 |
| 火气≥999 | 单击强制变安抚、头像框禁用、弹窗降火贴士 |
| 连续7天包容≥999 | 上榜推荐页 + 获"最值得交往的朋友"头衔 |

## 六、部署上线
将整个 huoqi-h5/ 目录上传到任意静态托管服务即可：
- GitHub Pages / Vercel / Netlify / 阿里云OSS / Nginx静态目录
- 部署后把 login.html 完整URL填入 share.html 生成二维码
