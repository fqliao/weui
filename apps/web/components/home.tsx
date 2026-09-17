import {
  ArrowRight,
  BookOpen,
  Compass,
  FileCheck2,
  Globe,
  Layers,
  Monitor,
  Play,
  Workflow,
  Zap,
} from 'lucide-react';
import type { Project } from './api';

const workflow = [
  {
    icon: Compass,
    title: '带着需求探索网站',
    text: '观察页面与功能路径，分阶段探索主链路和边界，生成测试草稿。',
  },
  {
    icon: FileCheck2,
    title: '由测试人员审核校准',
    text: '修改步骤、预期和登录身份，将确认后的草稿沉淀为正式用例。',
  },
  {
    icon: Play,
    title: '一键执行，持续回归',
    text: '复用已保存用例，单条或批量运行，在报告中核对每一步结果。',
  },
];

export function Home({ project }: { project: Project }) {
  const sites = project.environments.filter((e) => e.enabled && e.adapter === 'midscene-web-v1');
  return (
    <div className="product-home">
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-intro">
          <div className="eyebrow">WeUI · 面向测试团队</div>
          <h1 id="home-title">
            从网站探索，
            <br />
            到可复用的回归测试。
          </h1>
          <p>
            让 Agent 发现测试路径，让测试人员确认业务预期。
            <br className="home-desktop-break" />
            把一次探索，沉淀为可编辑、可执行、可追溯的测试用例。
          </p>
          <div className="home-actions">
            <a className="button primary" href="#/discoveries/new">
              <Compass size={17} />
              开始探索网站
            </a>
            <a className="button outline" href="#/cases">
              <Play size={16} />
              选择用例回归
            </a>
          </div>
          <a className="home-workspace" href="#/websites">
            <Globe size={14} />
            {sites.length ? `当前空间已接入 ${sites.length} 个测试网站` : '从接入您的第一个测试网站开始'}
            <ArrowRight size={14} />
          </a>
        </div>
        <ol className="home-workflow" aria-label="从探索到回归的使用流程">
          {workflow.map((step, i) => (
            <li key={step.title}>
              <span className="home-step-number">0{i + 1}</span>
              <div>
                <h2>
                  <step.icon size={17} />
                  {step.title}
                </h2>
                <p>{step.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <div className="home-capabilities">
        <section className="home-cache" aria-labelledby="cache-title">
          <span className="home-feature-label">
            <Zap size={16} />
            分层执行缓存
          </span>
          <h2 id="cache-title">重复测试，减少重复推理。</h2>
          <p>优先复用验证过的执行路径，页面变化时逐级回退分析。每次运行都能选择缓存优先，或直接实时推理。</p>
          <ol className="home-cache-flow" aria-label="默认执行顺序">
            <li>
              <small>二级缓存</small>
              <strong>静态脚本回放</strong>
              <span>复用已验证的操作</span>
            </li>
            <li>
              <small>一级缓存</small>
              <strong>规划与定位复用</strong>
              <span>减少模型调用</span>
            </li>
            <li>
              <small>实时推理</small>
              <strong>重新观察与执行</strong>
              <span>通过后更新适用缓存</span>
            </li>
          </ol>
          <small className="home-cache-note">
            验证失败不会覆盖通过基线；不适合缓存的用例可始终实时运行。
          </small>
        </section>
        <section className="home-evidence" aria-labelledby="evidence-title">
          <span className="home-feature-label">
            <Monitor size={16} />
            可视化执行与验证
          </span>
          <h2 id="evidence-title">看见过程，也查得到依据。</h2>
          <dl>
            <div>
              <dt>执行过程</dt>
              <dd>页面画面、操作步骤与时间线</dd>
            </div>
            <div>
              <dt>验证结果</dt>
              <dd>逐项预期、实际结果与截图证据</dd>
            </div>
            <div>
              <dt>缓存与消耗</dt>
              <dd>命中与回退记录、Token 与人民币估算</dd>
            </div>
          </dl>
          <div className="home-report-link">
            <span>Chrome · Edge · Firefox</span>
            <a href="#/tasks">
              查看测试记录
              <ArrowRight size={14} />
            </a>
          </div>
        </section>
      </div>

      <section className="home-foundation" aria-labelledby="foundation-title">
        <h2 id="foundation-title">把团队的知识与方法用起来</h2>
        <div>
          <a href="#/knowledge">
            <BookOpen size={20} />
            <span>
              <strong>领域知识</strong>
              <small>沉淀需求、业务规则与测试预期</small>
            </span>
            <ArrowRight size={14} />
          </a>
          <a href="#/skills">
            <Layers size={20} />
            <span>
              <strong>测试技能</strong>
              <small>维护、发布与复用团队的测试 Skill</small>
            </span>
            <ArrowRight size={14} />
          </a>
          <a href="#/tools">
            <Workflow size={20} />
            <span>
              <strong>工具能力</strong>
              <small>查看已注册工具及其授权范围</small>
            </span>
            <ArrowRight size={14} />
          </a>
        </div>
      </section>
    </div>
  );
}
