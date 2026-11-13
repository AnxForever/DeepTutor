# P2 调研：从单份报告到可回查的学生教学记录

> 实现范围更新：P2 已完成文字/Word采集、草稿连续性和课堂讲义，并发布到 fork。P3 已实现下文的稳定学生记录、显式报告版本关联与证据时间线；比较面板和教学待办仍是后续建议。实现与验证状态见 [功能台账](TEACHING_ANALYSIS.md)。

调研日期：2026-11-13。当前 DeepTutor fork 已有单份作业分析、评分标准版本、教师确认补练、独立作答记录与作废审计。本次只研究：怎样把同一学生的多份材料可靠关联，何时可以比较表现，以及怎样形成下一次教学动作。

关于多作业记录，建议收窄为 **稳定的学生记录 ID → 教师明确关联已确认报告的具体版本 → 可回查的证据时间线与少量教学待办**。暂不把自由填写的学生标签当长期身份，也不从不同作业的几个结果生成能力百分比曲线。此建议来自下述实现与官方流程的组合推论，不是已经验证的课堂效果。

## 本次读取的独立证据

| 系统 | 固定快照与许可证 | 本次实际阅读 |
| --- | --- | --- |
| Kolibri | `fe298f54494c1e1cf4ecd42ee3d153d6c6305b85`，提交日期 2026-11-11；根代码为 [MIT](https://github.com/learningequality/kolibri/blob/fe298f54494c1e1cf4ecd42ee3d153d6c6305b85/LICENSE) | 身份模型、日志模型、教练困难题汇总及其测试 |
| Moodle | `afbcc55fa1bd80dcdd887b8965dd8c28c0f3bbda`，提交日期 2026-11-11；根 [COPYING.txt](https://github.com/moodle/moodle/blob/afbcc55fa1bd80dcdd887b8965dd8c28c0f3bbda/COPYING.txt) 为 GPLv3，用户报告源码标注 GPLv3 or later | 用户报告入口/实现、用户报告权限测试、测验最终成绩计算 |
| ASSISTments | 2026-11-13 读取公开[学生进展报告说明](https://www.assistments.org/individual-resource/the-student-progress-report) | 官方描述的选学生、日期过滤、多作业指标及详情跳转；没有登录实测 |

两份仓库都能查到近期提交；这只能说明所选快照近期有维护。源码与测试均为只读核查，没有安装或运行上游系统，也没有复制实现。Moodle 在此仅作为工作流与边界参考；实际复用其代码需要单独处理许可证要求，不能把它作为 Apache fork 的无条件可复制组件。第三方依赖、教材和题目也不由根许可证自动覆盖。

### 1. 身份是实体关系，显示名字只是属性

Kolibri 的 `FacilityUser` 单独保存显示名、用户名与所属 facility，并通过 membership/role 判断权限；日志的 `user` 是到该实体的外键。其测试甚至专门验证 ORM 层能创建两个相同 username 的对象，说明连接历史记录不能仅依靠可见字符串。正常注册路径另有校验，该测试不代表注册界面会接受所有重复账户。[身份模型](https://github.com/learningequality/kolibri/blob/fe298f54494c1e1cf4ecd42ee3d153d6c6305b85/kolibri/core/auth/models.py#L903-L943)、[日志外键](https://github.com/learningequality/kolibri/blob/fe298f54494c1e1cf4ecd42ee3d153d6c6305b85/kolibri/core/logger/models.py#L238-L246)、[同 username 的 ORM 测试](https://github.com/learningequality/kolibri/blob/fe298f54494c1e1cf4ecd42ee3d153d6c6305b85/kolibri/core/auth/test/test_models.py#L690-L697)。

Moodle 用户报告以 `courseid`、`userid` 定位对象；入口还核验课程权限、可评分用户、分组与有效用户。报告实现按用户 ID 获取姓名，按 grade item ID + user ID 取成绩。它的 API 测试验证教师只取得自己组内学生的数据，学生不能取得另一学生的数据。[入口权限与选择](https://github.com/moodle/moodle/blob/afbcc55fa1bd80dcdd887b8965dd8c28c0f3bbda/public/grade/report/user/index.php#L30-L76)、[报告实体查询](https://github.com/moodle/moodle/blob/afbcc55fa1bd80dcdd887b8965dd8c28c0f3bbda/public/grade/report/user/classes/report/user.php#L300-L313)、[权限回归](https://github.com/moodle/moodle/blob/afbcc55fa1bd80dcdd887b8965dd8c28c0f3bbda/public/grade/report/user/tests/externallib_test.php#L91-L188)。

**对本项目的约束：**当前 `student_ref` 仍可作为匿名显示标签，但不应自动升级为跨作业连接键。新的学生记录可以有自己生成的 UUID；它既不是登录账号，也不授予其他工作区或账号的数据访问权。

### 2. “最近表现”必须先定义纳入哪次、哪种状态

Kolibri 的 practice-quiz 汇总按用户与内容选择最近一次已完成的 try。测试覆盖重复尝试后采用最近完成结果，以及“时间更新但并未完成”的新 try 不应挤掉先前完成记录。另一条测验路径还区分进行中与已提交，并避免重复分组关联重复计数。[最近完成的筛选](https://github.com/learningequality/kolibri/blob/fe298f54494c1e1cf4ecd42ee3d153d6c6305b85/kolibri/plugins/coach/viewsets/difficult_questions.py#L180-L239)、[重复尝试测试](https://github.com/learningequality/kolibri/blob/fe298f54494c1e1cf4ecd42ee3d153d6c6305b85/kolibri/plugins/coach/test/test_difficult_questions.py#L1017-L1114)、[提交及去重测试](https://github.com/learningequality/kolibri/blob/fe298f54494c1e1cf4ecd42ee3d153d6c6305b85/kolibri/plugins/coach/test/test_difficult_questions.py#L609-L699)。

Moodle 的测验最终成绩可以按配置取首次、末次、平均或最高；平均规则跳过 `null`，没有有效成绩时仍返回 `null`。因此，报告里一个最终成绩可能已经是活动策略处理后的值，并不等于一次原始作答，更不等于通用知识掌握概率。这里读到了实现，没有运行该计算器或核验其专门测试。[成绩策略实现](https://github.com/moodle/moodle/blob/afbcc55fa1bd80dcdd887b8965dd8c28c0f3bbda/public/mod/quiz/classes/grade_calculator.php#L157-L239)。

**对本项目的约束：**不要把 P1 的所有 attempts 直接求均值，也不要默认用最后一条。至少需要说明来源、是否被作废、题目/标准版本、教师是否已评分、辅助情况和选取规则。未评分与缺少材料不能自动算成失败。

### 3. 多份作业可以先做详情索引，无需先做能力曲线

ASSISTments 官方进展页先在班级范围内选定学生，再按日期查看多份作业。页面分别提供完成情况、作业得分、用时等指标，并能从某次作业跳回该学生的作业详情。文档还明确 Skill Builders 不属于该页，而有独立报告。这说明即使在同一产品内，不同任务类型也未必应混在一个摘要中。[官方学生进展报告](https://www.assistments.org/individual-resource/the-student-progress-report)。

**对本项目的约束：**可以借鉴“单学生 → 有时间范围的多份材料 → 一键回到原题证据”的结构。其平台内有定义好的作业分数和班级数据；当前 fork 的模型观察、教师评阅与补练记录不能直接复制这些百分比指标。报告生成时间也不一定是实际作答时间。

## 最多五项可采用的设计

| 优先顺序 | 建议、依据与最小范围 | 验收与失败行为 |
| --- | --- | --- |
| 1 | **学生记录 ID 与显式关联。** 结合 Kolibri/Moodle 的实体关联边界，建立工作区内的匿名学生记录；教师逐项确认关联 `report_id + confirmed revision`。不要求全班花名册、学生登录或更多个人信息。 | 同名创建两个记录仍彼此独立；改显示名不迁移历史；跨工作区 UUID 被拒；关联成功请求重试不重复记一份材料。|
| 2 | **版本化证据时间线。** 借鉴 ASSISTments 的作业详情导航，并沿用 P1 的模板/题目快照。每条展示报告日期、教师注明的作答日期（若有）、原标签、题号、引文与具体版本。 | 源报告升级时显示有新版本，教师明确采纳后再更换关联；解除关联或作废有记录；缺失来源显示不可用，不凭空补内容；不把报告生成时间冒充作答时间。 |
| 3 | **先做可比性提示与并排回查。** Kolibri/Moodle 说明纳入规则会改变结果。相同知识点文字仅供检索；题目、标准、辅助状态不同要直接显示，跨报告归为同一关注点由教师确认。 | 独立与辅助作答分开；未评分、未知、作废分别列示；换题目/评分标准后不自动声称进步或退步。初版不给能力概率，也不对不同任务机械平均。 |
| 4 | **小型教学待办。** 将已确认关注点及 P1 追问做为引用，教师写下一次“补材料、讲解、补测”等动作，完成状态只表示教师已处理。无需为每次打开页面重新调模型。 | 每项能回到证据和补练；完成待办不授予掌握；来源被修订或撤回后标记待复核；失败保留编辑，不反复生成同一建议。 |
| 5 | **渐进入口。** 学生记录只收代号和可选备注，先选择现有已确认报告，再显示比较/待办；默认展示具体证据和待确认项，避免先让教师配置知识图谱与报表参数。 | 没有可关联报告时给出明确下一步；没有足够可比材料时显示“尚不能比较”。文档导入仍可能更能降低首次门槛，但应先单独核对现有 parser/格式/许可证/失败路径，再进入实现，不能因本报告直接承诺 OCR。 |

以上 1–3 是能与现有 P0/P1 接上的最小 P2；第 4 项可在证据关联可靠后接入。第 5 项是呈现约束。无需同步引入完整 LMS、另一套 Agent 运行时、自动知识点图谱、班级排名或另一条掌握度计算链。

## 需要留在证据层的差异

- **身份：**稳定学生记录 ID、当前显示标签和历史来源标签分开；同名不是同人，改名不是重新归档。
- **版本：**关联的报告版本、该版所用评分标准、补练题目版本和具体 attempt ID 都应可回查。新版本存在不等于已经接受它。
- **状态：**作废、未评分、确认留白、未提供、转录不确定和有辅助的答对，不能压成一个布尔正确率。
- **时间：**作答发生时间、教师录入时间、报告生成时间可以不同。缺少发生时间时明确使用哪个时间展示顺序。
- **可比性：**题目难度、任务类型、评分标准和辅助条件不同，可能无法比较；来源数量增加不自动等于测量更准确。

## 本轮覆盖与未验证项

本文件最初交付时只有调研，未修改产品源码；其历史研究覆盖记为 partial。后续 P3 已实现稳定学生记录、显式跨作业关联和证据时间线，比较和待办仍处于建议状态。关于身份/权限/提交与成绩策略的源码证据支持上述约束；实现验证不能代替教师日常工作中的反馈，产品适用性覆盖仍记为 partial。

没有运行 Kolibri/Moodle 测试、登录教师产品、上传真实学生资料、评估 OCR、调用项目真实模型或验证教学收益。源代码中的测试被读取，只证明维护者写了相应回归，不等于本机已经通过上游测试。对当前 fork 的改动需要另做权限、版本、重试、作废、缺失与浏览器验收。
