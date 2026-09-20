import { InvariantViolationError } from './errors.ts';
import { Mission } from './mission.ts';
import type { MissionContract, MissionExecutionMode, OriginChannel } from './payloads.ts';
import type { MissionSnapshot, ProjectSnapshot } from './snapshot.ts';

export interface ProjectInit {
  id: string;
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

  createMission(init: {
    id: string;
    contract?: MissionContract;
    origin?: OriginChannel;
    executionMode?: MissionExecutionMode;
  }): Mission {
    if (this.#missions.some((mission) => mission.id === init.id)) {
      throw new InvariantViolationError(
        'DUPLICATE_ID',
        `mission id ${init.id} already exists in project ${this.#id}`,
      );
    }
    const mission = new Mission({
      id: init.id,
      projectId: this.#id,
      project: this,
      contract: init.contract,
      origin: init.origin,
      executionMode: init.executionMode,
    });
    this.#missions.push(mission);
    return mission;
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
