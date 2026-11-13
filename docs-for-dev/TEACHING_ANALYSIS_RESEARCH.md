# 教师作业分析：调研依据与功能路线

调研日期：2026-11-13。目标是让教师从一名学生的一份作业出发，核对原始作答，得到有依据、可修改的教学分析，再决定下一步怎么教。

本轮采用 **“材料核对 → 分析草稿 → 教师修订与确认”** 的小闭环。功能丰富度优先体现在证据可回查、下一步可执行和失败可恢复，而不是增加一批需要教师理解的工具入口。

下面区分调研事实、当前设计决定与后续建议。竞品资料来自公开官方页面，未登录实测；开源项目读取了固定版本源码与测试，未在本机运行。它们不能证明 DeepTutor 已提高诊断准确率、教学效率或学生学习效果。当前功能交付状态仍以本项目测试、浏览器验收及实际模型评估记录为准。

## 公开竞品流程

| 产品 | 一手证据支持的流程 | 采用原因与边界 |
| --- | --- | --- |
| ASSISTments | 作业报告可进入题目或学生详情，查看具体作答、常见错误、提示使用情况；开放回答有人工评阅入口。[Assignment Reports](https://www.assistments.org/individual-resource/assignment-reports) | 报告应让教师回到学生的实际表现。其依据主要是产品内的题目与提交记录，不能据此认为它能诊断任意外部手写试卷。 |
| ASSISTments | 从报告选择学生，按原错题安排少量相似题或对应标准的题，由教师决定是否复用旧题。[Targeted Follow Up Assignments](https://www.assistments.org/individual-resource/targeted-follow-up-assignments-assistments-plus) | 关注点应连接下一次检查，而不是停在“加强练习”。借鉴任务链，不承诺复现其题库或自动布置系统。 |
| Khanmigo for Teachers | 按教师任务组织工具；产物在 Documents 中回看、编辑和导出；Class Snapshot 描述近期产品内学习摘要，Recommend Assignments 可推荐内容。[官方 Teacher Tools 帮助](https://support.khanacademy.org/hc/en-us/articles/14799047733645-What-teacher-tools-are-available-on-Khanmigo) | 入口用“分析学生作业”等任务语言，报告能再找到和复用。近期学习摘要不能直接等价为任意外部资料的薄弱点诊断。 |
| MagicSchool | Writing Feedback 从作品和评价标准生成反馈初稿，教师审阅、修改后再交给学生；Rubric Generator 生成可编辑的评价标准。[Writing Feedback](https://www.magicschool.ai/tools/writing-feedback)、[Rubric Generator](https://www.magicschool.ai/tools/rubric-generator) | 把评分依据和教师确认放在流程中。作文反馈的产品说明不能证明数学推理诊断可靠；生成的标准也需教师核对。 |

以上均为产品方描述的流程。Khan Academy 另有 [2024 年工具总览](https://blog.khanacademy.org/khanmigo-features/)，本轮仅视作历史设计背景，不作为当前全部功能状态的证明。

## 已核对的开源实现

两个项目相互补充：Kolibri 研究教师如何查看学习表现，LibreChat 研究材料如何可靠进入模型与修订流程。LibreChat 是通用 AI 应用，本轮没有将它视为教育诊断系统。

| 项目与固定版本 | 根许可证与维护快照 | 实读源码和测试；可借鉴的行为 |
| --- | --- | --- |
| [Kolibri](https://github.com/learningequality/kolibri)，`fe298f54494c1e1cf4ecd42ee3d153d6c6305b85` | [MIT](https://github.com/learningequality/kolibri/blob/fe298f54494c1e1cf4ecd42ee3d153d6c6305b85/LICENSE)；该提交为 2026-11-11，查询时未归档 | [困难题 API](https://github.com/learningequality/kolibri/blob/fe298f54494c1e1cf4ecd42ee3d153d6c6305b85/kolibri/plugins/coach/viewsets/difficult_questions.py)校验课堂权限、完成状态和统计分母；[个人报告](https://github.com/learningequality/kolibri/blob/fe298f54494c1e1cf4ecd42ee3d153d6c6305b85/kolibri/plugins/coach/frontend/views/common/LearnerExerciseReport.vue)保留 learner、question、try、interaction 的定位；[测试](https://github.com/learningequality/kolibri/blob/fe298f54494c1e1cf4ecd42ee3d153d6c6305b85/kolibri/plugins/coach/test/test_difficult_questions.py)覆盖学生拒绝访问、重复分组不重复计数及未完成提交处理。 |
| [LibreChat](https://github.com/LibreChat-AI/LibreChat)，`2e6b23cb08b99b2b682ad83d92148c64e40e53f7` | [MIT](https://github.com/LibreChat-AI/LibreChat/blob/2e6b23cb08b99b2b682ad83d92148c64e40e53f7/LICENSE)；该提交为 2026-11-12，查询时未归档 | [文件上下文](https://github.com/LibreChat-AI/LibreChat/blob/2e6b23cb08b99b2b682ad83d92148c64e40e53f7/packages/api/src/files/context.ts)让已提取文本直接进入上下文；[粘贴材料编辑](https://github.com/LibreChat-AI/LibreChat/blob/2e6b23cb08b99b2b682ad83d92148c64e40e53f7/client/src/hooks/Files/usePastedTextEdit.ts)用会话、草稿标识及请求序号隔离过期操作；[文件处理测试](https://github.com/LibreChat-AI/LibreChat/blob/2e6b23cb08b99b2b682ad83d92148c64e40e53f7/api/server/services/Files/process.spec.js)区分提取失败和保存失败；[草稿测试](https://github.com/LibreChat-AI/LibreChat/blob/2e6b23cb08b99b2b682ad83d92148c64e40e53f7/client/src/hooks/Files/__tests__/usePastedTextEdit.drafts.spec.tsx)防止旧附件和旧回包覆盖新修改。 |

近期提交只证明该快照近期有维护，不代表所有功能稳定。Kolibri 的 [AttemptLogItem 测试](https://github.com/learningequality/kolibri/blob/fe298f54494c1e1cf4ecd42ee3d153d6c6305b85/packages/kolibri-common/components/quizzes/QuizReport/__tests__/attempt-log-item.spec.js)自身也未穷举每个状态，不能把成熟项目的存在等同于完整测试覆盖。

两个根代码许可证均为 MIT，但第三方依赖、教材、题目、图片和品牌可能有各自权利边界。本轮仅借鉴模式，没有复制外部实现或加入第二套聊天、Agent、课程运行时。以后若实际复用代码，应逐文件核对许可并保留要求的版权与许可声明。

## 当前 MVP 采用的四项决定

这里的“采用”表示本轮实现的设计约束；验收通过与否需另行记录。

| 决定 | 来源与采用原因 | 本轮范围 | 验收与失败行为 |
| --- | --- | --- | --- |
| 结论旁保留证据锚点 | ASSISTments 的[作答详情](https://www.assistments.org/individual-resource/assignment-reports)和 Kolibri 的[个人报告导航](https://github.com/learningequality/kolibri/blob/fe298f54494c1e1cf4ecd42ee3d153d6c6305b85/kolibri/plugins/coach/frontend/views/common/LearnerExerciseReport.vue)：教师需要知道判断根据哪道题、哪一步。 | 报告保留题号、学生原答或步骤引文、材料位置；观察与可能原因分开。 | 题号必须存在，引文必须逐字出现在对应原字段；浏览器能从证据返回原题。引文存在只证明出处，归因仍需教师核对。 |
| 原答状态分别保存 | Kolibri 的[作答状态显示](https://github.com/learningequality/kolibri/blob/fe298f54494c1e1cf4ecd42ee3d153d6c6305b85/packages/kolibri-common/components/quizzes/QuizReport/AttemptLogItem.vue)给出基础；导入材料还需要区分“未收录”和“确认留白”。 | 保留已提供、确认留白、未知作答；转录不确定及辅助情况另列。 | `null` 不自动变成学生未答；未知或转录未确认不能判为确定错误。测试覆盖正确答案但过程错误、参考答案冲突及单次运算失误。 |
| 草稿、教师确认和修订历史分开 | MagicSchool 的[反馈审阅流程](https://www.magicschool.ai/tools/writing-feedback)：AI 完成生成不代表教师认可。 | 教师可编辑解释和教学建议；保存、确认与版本可回查。修改输入后旧分析失效。 | 生成不自动确认；陈旧输入指纹或 revision 冲突拒绝覆盖；旧版本保留。确认报告不改变学生 mastery，也不覆盖教师自己的学习档案。 |
| 失败保留已完成的编辑 | LibreChat 的[草稿编辑实现](https://github.com/LibreChat-AI/LibreChat/blob/2e6b23cb08b99b2b682ad83d92148c64e40e53f7/client/src/hooks/Files/usePastedTextEdit.ts)及[恢复测试](https://github.com/LibreChat-AI/LibreChat/blob/2e6b23cb08b99b2b682ad83d92148c64e40e53f7/client/src/hooks/Files/__tests__/usePastedTextEdit.drafts.spec.tsx)：网络失败不应迫使教师重新整理材料。 | 分开显示导入、分析、保存失败；切换工作区或材料后排除过期回包。 | 保存失败保留报告修改且只重试保存；不会重新调用模型。慢请求不能把新材料或学生范围覆盖成旧值。 |

小份作业先作为当前任务的直接上下文，不要求教师先建知识库。该决定借鉴 LibreChat 的[文件上下文实现](https://github.com/LibreChat-AI/LibreChat/blob/2e6b23cb08b99b2b682ad83d92148c64e40e53f7/packages/api/src/files/context.ts)，但需独立限制本次全部材料的总大小。超出预算应提示分批，不能静默截断后声称分析了整份作业。

## 后续路线与进入条件

下表保留调研给出的路线与进入条件；调研本身不代表功能交付，当前实现状态见本节更新和功能验收记录。

P1 进展更新：本轮已经实现手工评分标准的版本库，以及将现有报告追问转为教师核对的补练、记录多次作答和作废审计。它们按下表的约束验收；AI 生成标准、额外生成新变式、自动批改、多作业趋势及班级统计仍是后续范围。补练结果来自教师明确评阅，不将其冒充模型评分或掌握概率。

| 优先级 | 功能与来源 | 采用原因、范围 | 开始前需要满足的验收 |
| --- | --- | --- | --- |
| P1 | **教师评分标准模板**。参考 MagicSchool 的 [Rubric Generator](https://www.magicschool.ai/tools/rubric-generator)。 | 教师可保存和复用自己的评价标准；AI 生成的标准先作为待核对建议，不临时猜测课程要求。 | 标准有版本及适用学科/任务，教师可修改；分析记录具体采用哪个版本。标准改动使相关分析需复核，不能悄悄改历史判断。 |
| P1 | **从关注点到少量补练，再收集独立 attempt**。参考 ASSISTments 的[针对性补练](https://www.assistments.org/individual-resource/targeted-follow-up-assignments-assistments-plus)及 Kolibri 的[作答记录统计](https://github.com/learningequality/kolibri/blob/fe298f54494c1e1cf4ecd42ee3d153d6c6305b85/kolibri/plugins/coach/viewsets/difficult_questions.py)。 | 为一个已确认关注点生成或选择少量待核对题，附参考依据；用新作答检查改善，不机械复述刚讲出的答案。 | 有新的 attempt 标识、时间、题目版本和辅助状态；重传同一材料幂等，同题的新作答不被题目去重吞掉。辅助正确、独立正确、稳定掌握分别说明。 |
| P2 | **同一学生的多作业趋势**。参考 Khanmigo 的[近期工作摘要](https://support.khanacademy.org/hc/en-us/articles/14799047733645-What-teacher-tools-are-available-on-Khanmigo)与 Kolibri 的[最近已完成记录测试](https://github.com/learningequality/kolibri/blob/fe298f54494c1e1cf4ecd42ee3d153d6c6305b85/kolibri/plugins/coach/test/test_difficult_questions.py)。 | 在少量已核对作业间比较某知识点的表现；同时保留原问题与新证据。 | 学生身份、作业时间和课程映射可靠；修正、撤回及过期证据有规则。没有足够独立数据时不画看似精确的能力曲线，也不让旧错题永久定义学生。 |
| P3 | **有授权隔离后的班级共性问题与分层教学**。参考 Kolibri 的[课堂权限与统计](https://github.com/learningequality/kolibri/blob/fe298f54494c1e1cf4ecd42ee3d153d6c6305b85/kolibri/plugins/coach/viewsets/difficult_questions.py)和 ASSISTments 的[作业报告](https://www.assistments.org/individual-resource/assignment-reports)。 | 汇总常见错误、安排教师确认的分组或补练。相同错答只表明表现相似，不能直接认定同一错误原因。 | 教师只能访问获授权学生；统计明示人数、分母、缺失数据、提交状态和使用哪次作答。跨班/跨教师访问测试通过，标签不充当授权凭据。 |

## 文档、识别与实际效果的边界

照片、扫描 PDF 和手写公式应作为独立后续功能接入现有解析层，保留原页、题目位置和教师纠正步骤。LibreChat 的[官方 OCR 说明](https://www.librechat.ai/docs/features/ocr)可以提供路由与失败提示参考，不能证明任何具体手写识别率。本轮文本样例不能替代原始图片端到端验收。

已有合成案例可验证协议与失败路径；诊断质量还需同一模型设置下的基线比较、盲评及教师试用。报告应分别记录结构验证、真实模型行为、浏览器操作和实际教学结果，避免把其中一项通过写成全部功能有效。

不额外引入 Agent 框架：当前缺口主要在输入证据、身份范围、版本、教师动作与恢复流程。复用 DeepTutor 的模型服务、工作区隔离和评测基础，可以减少多套运行时之间的账户、上下文与事件状态对接。
