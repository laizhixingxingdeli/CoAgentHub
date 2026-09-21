import { InvariantViolationError } from './errors.ts';
import { Mission } from './mission.ts';
import type {
  ComplexityAssessment,
  ExecutionBudget,
  MissionContract,
  MissionExecutionMode,
  OriginChannel,
  RunKind,
  WorkOrder,
} from './payloads.ts';
import type { MissionSnapshot, ProjectSnapshot } from './snapshot.ts';
import type { WorkItem } from './work-item.ts';

export interface ProjectInit {
  id: string;
}

/** createMission / createMissionWithInitialWorkItem 共用的 Mission 初始化字段。 */
export interface ProjectMissionInit {
  id: string;
  contract?: MissionContract;
  origin?: OriginChannel;
  executionMode?: MissionExecutionMode;
  runKind?: RunKind;
  complexityAssessment?: ComplexityAssessment;
  executionBudget?: ExecutionBudget;
}

/**
 * Fast Lane frozen seed：order 必填，不支持 title-only legacy。
 * WorkOrder 校验/冻结仍走 Mission.createWorkItem → WorkItem 现有路径。
 */
export interface InitialWorkItemSeed {
  id: string;
  title: string;
  order: WorkOrder;
}

/**
 * Mission 的容器，同时是不变量 C 的内存边界：
 * 「同一 Project 同一时刻最多一个 Mission 处于 executing」。
 * 不同 Project 之间互不影响。
 */
export class Project {
  #id: string;
  #missions: Mission[] = [];

  constructor(init: ProjectInit) {
    this.#id = init.id;
  }

  static create(init: ProjectInit): Project {
    return new Project(init);
  }

  get id(): string {
    return this.#id;
  }

  /** 只读副本。 */
  get missions(): readonly Mission[] {
    return [...this.#missions];
  }

  createMission(init: ProjectMissionInit): Mission {
    this.#assertMissionIdAvailable(init.id);
    const mission = this.#newMission(init);
    this.#missions.push(mission);
    return mission;
  }

  /**
   * 在 Project 聚合内原子创建 Mission + 唯一初始 Frozen WorkItem。
   *
   * 顺序：查 id → 构造 Mission（先不入 #missions）→ createWorkItem（复用
   * WorkOrder strict 校验/冻结）→ 成功后才 push。任一失败 #missions 不变，
   * Project 绝不残留半个 Mission。
   */
  createMissionWithInitialWorkItem(
    init: ProjectMissionInit & { initialWorkItem: InitialWorkItemSeed },
  ): { mission: Mission; workItem: WorkItem } {
    this.#assertMissionIdAvailable(init.id);
    const mission = this.#newMission({
      id: init.id,
      contract: init.contract,
      origin: init.origin,
      executionMode: init.executionMode,
      runKind: init.runKind,
      complexityAssessment: init.complexityAssessment,
      executionBudget: init.executionBudget,
    });
    const workItem = mission.createWorkItem({
      id: init.initialWorkItem.id,
      title: init.initialWorkItem.title,
      order: init.initialWorkItem.order,
    });
    this.#missions.push(mission);
    return { mission, workItem };
  }

  #assertMissionIdAvailable(id: string): void {
    if (this.#missions.some((mission) => mission.id === id)) {
      throw new InvariantViolationError(
        'DUPLICATE_ID',
        `mission id ${id} already exists in project ${this.#id}`,
      );
    }
  }

  #newMission(init: ProjectMissionInit): Mission {
    return new Mission({
      id: init.id,
      projectId: this.#id,
      project: this,
      contract: init.contract,
      origin: init.origin,
      executionMode: init.executionMode,
      runKind: init.runKind,
      complexityAssessment: init.complexityAssessment,
      executionBudget: init.executionBudget,
    });
  }

  toSnapshot(): ProjectSnapshot {
    return { id: this.#id, missions: this.#missions.map((mission) => mission.toSnapshot()) };
  }

  /** 直接装配历史状态，不重放动作、不重新校验不变量。 */
  static restore(snapshot: ProjectSnapshot): Project {
    const project = Project.create({ id: snapshot.id });
    project.#missions = (snapshot.missions ?? []).map((mission: MissionSnapshot) =>
      Mission.restore(mission, project),
    );
    return project;
  }

  /**
   * 除 `exceptId` 之外，本 Project 里是否还有别的 Mission 在改动中。
   * 由 `Mission.startExecuting()` 在改自身状态之前调用。
   */
  hasOtherMutatingMission(exceptId: string): boolean {
    return this.#missions.some(
      (mission) => mission.id !== exceptId && mission.isMutating,
    );
  }
}
