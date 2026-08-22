import { useCallback, useEffect, useState } from "react";
import {
  PARTICIPANT_ID_KEY,
  participantIdentityHeaders,
} from "@/lib/api-client";
import { t } from "@/lib/i18n";
import { useIdentityStore } from "@/lib/stores/identity";

/** The bound participant's own registration (GET /api/participants, filtered by id). */
type ParticipantInfo = {
  id: string;
  name: string;
  device: string | null;
};

/**
 * 身份面板状态与逻辑(从 useGroupsPage 剥离,供侧栏身份切换器与群组页
 * 「参与方设置」区共用)。身份是全局的「设一次、偶尔切换」的东西,因此绑定
 * 状态以 useIdentityStore 为唯一数据源 —— 切换/清除后 store 的
 * setIdentity/clearIdentity 同步写入 localStorage,后续请求的
 * X-Participant-Id 头立即跟随(api-client 按请求读取)。
 *
 * 挂载时用 localStorage 校准一次 store:真实运行中两者由 store 保持同步,
 * 但测试/旧标签页场景下 store 可能先于 localStorage 初始化,校准保证任何
 * 挂载点读到的当前身份与持久化值一致。
 */
export function useIdentityPanel() {
  const boundParticipantId = useIdentityStore((s) => s.participantId);

  // 挂载校准(仅首次):localStorage 有值则 adopt,无值则清除(幂等,不影响
  // store 已同步的场景)。
  useEffect(() => {
    const stored =
      typeof localStorage !== "undefined"
        ? (localStorage.getItem(PARTICIPANT_ID_KEY) ?? "")
        : "";
    if (stored !== boundParticipantId) {
      if (stored) {
        useIdentityStore.getState().setIdentity(stored);
      } else {
        useIdentityStore.getState().clearIdentity();
      }
    }
    // 只在挂载时校准一次;此后 store 的变化由 setIdentity/clearIdentity 驱动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 手动输入 participant id(全信模型:任意声称的 id 都被接受,不存在的回落
  // Local User)。下拉选择在身份面板的「已有 Participant」列表里完成。
  const [identityInput, setIdentityInput] = useState("");
  // Ticket 20: Participant 设置展开区 — 绑定成功后可见,展示并编辑自己的注册信息。
  const [participantInfo, setParticipantInfo] =
    useState<ParticipantInfo | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [deviceInput, setDeviceInput] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  // Ticket 28: 注册新 Participant — 替代终端 curl 注册;注册成功即自动绑定
  // (id 覆盖写入,语义:注册即切换身份,不强制清除旧绑定)。
  const [registerOpen, setRegisterOpen] = useState(false);
  const [regName, setRegName] = useState("");
  const [regDevice, setRegDevice] = useState("");
  const [registering, setRegistering] = useState(false);
  // Ticket 29: 身份面板 — 已有 Participant 名册(公开 GET /api/participants,无需鉴权)。
  const [participants, setParticipants] = useState<ParticipantInfo[]>([]);
  const [participantsLoading, setParticipantsLoading] = useState(false);
  const [participantsError, setParticipantsError] = useState<string | null>(
    null,
  );
  // 身份区反馈(切换/注册/清除):显示在侧栏切换器的展开面板里。
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 「参与方设置」区反馈:显示在群组页的设置卡片里,与身份区反馈分开,避免
  // 两个挂载点互相覆盖提示。
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  // Ticket 29: 拉取已有 Participant 名册(公开端点,无需鉴权)。绑定/清除/注册后
  // 由 commitIdentity 触发刷新;加载失败只影响面板内的列表区,不阻塞页面。
  const loadParticipants = useCallback(async () => {
    setParticipantsLoading(true);
    setParticipantsError(null);
    try {
      const res = await fetch("/api/participants");
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as ParticipantInfo[];
      setParticipants(data);
    } catch (e) {
      setParticipantsError(
        t("groups.identity.listFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setParticipantsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadParticipants();
  }, [loadParticipants]);

  const commitIdentity = (participantId: string | null) => {
    const trimmed = participantId?.trim() ?? null;
    if (trimmed) {
      useIdentityStore.getState().setIdentity(trimmed);
    } else {
      useIdentityStore.getState().clearIdentity();
    }
    loadParticipants();
  };

  const handleSaveIdentity = () => {
    const id = identityInput.trim();
    if (!id) {
      return;
    }
    commitIdentity(id);
    setIdentityInput("");
  };

  const handleClearIdentity = () => {
    commitIdentity(null);
  };

  // 全信模型:选择身份 = 声明身份,无需任何服务端调用(reset-token 端点已删除)。
  const handleBind = (participant: ParticipantInfo) => {
    setMessage(null);
    setError(null);
    commitIdentity(participant.id);
    setMessage(t("groups.identity.switched", { name: participant.name }));
  };

  // Ticket 28: 前端注册 participant(POST /api/participants,公开端点)。成功后用返回的
  // id 自动完成绑定(commitIdentity 覆盖写入 localStorage 并刷新列表)。
  const handleRegister = async () => {
    const name = regName.trim();
    if (!name) {
      setError(t("groups.identity.nameRequired"));
      return;
    }
    setRegistering(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/participants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          device: regDevice.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          `HTTP ${res.status}${body?.message ? `: ${body.message}` : ""}`,
        );
      }
      const participant = (await res.json()) as {
        id: string;
        name: string;
      };
      // 注册即切换身份:id 覆盖写入,不强制清除旧绑定。
      commitIdentity(participant.id);
      setRegName("");
      setRegDevice("");
      setMessage(
        t("groups.identity.registeredAndBound", { name: participant.name }),
      );
    } catch (e) {
      setError(
        t("groups.identity.registerFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setRegistering(false);
    }
  };

  // Ticket 20: 拉取自己(coagenthub.participantId)的注册信息并预填设置表单。加载失败
  // 不影响列表页,设置区静默留空。
  const loadParticipantInfo = useCallback(async () => {
    const participantId =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(PARTICIPANT_ID_KEY)
        : null;
    if (!participantId) {
      setParticipantInfo(null);
      return;
    }
    try {
      const headers = participantIdentityHeaders();
      const res = await fetch("/api/participants", { headers });
      if (!res.ok) {
        return;
      }
      const participants = (await res.json()) as ParticipantInfo[];
      const mine = participants.find((a) => a.id === participantId) ?? null;
      setParticipantInfo(mine);
      if (mine) {
        setNameInput(mine.name);
        setDeviceInput(mine.device ?? "");
      }
    } catch {
      // 静默失败:设置区保持原样。
    }
  }, []);

  // Ticket 20: 绑定 participant 后加载其注册信息(GET /api/participants 找到自己的 id)。
  useEffect(() => {
    if (boundParticipantId) {
      loadParticipantInfo();
    }
  }, [boundParticipantId, loadParticipantInfo]);

  const handleSaveSettings = async () => {
    const participantId =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(PARTICIPANT_ID_KEY)
        : null;
    if (!participantId) {
      setSettingsError(t("groups.settings.noParticipant"));
      return;
    }
    // 名称必填:空名称会被 PATCH 静默丢弃(undefined),提示而不是假装成功。
    if (!nameInput.trim()) {
      setSettingsError(t("groups.settings.nameEmpty"));
      return;
    }
    setSavingSettings(true);
    setSettingsMessage(null);
    setSettingsError(null);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...participantIdentityHeaders(),
      };
      // device 为空时发送 null 表示清空(与后端 PATCH 语义一致)。
      const res = await fetch(`/api/participants/${participantId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          name: nameInput.trim() || undefined,
          device: deviceInput.trim() ? deviceInput.trim() : null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          `HTTP ${res.status}${body?.message ? `: ${body.message}` : ""}`,
        );
      }
      setSettingsMessage(t("groups.settings.saved"));
      await loadParticipantInfo();
    } catch (e) {
      setSettingsError(
        t("groups.settings.saveFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setSavingSettings(false);
    }
  };

  // Ticket 29: 当前绑定身份 — 从名册里找,找不到则回退 participantInfo(设置区已
  // 加载的自己的注册信息)。localStorage 在 commitIdentity 里同步写入,渲染时
  // 读取即为最新绑定。
  const currentParticipant =
    participants.find((a) => a.id === boundParticipantId) ??
    participantInfo ??
    null;

  return {
    boundParticipantId,
    identityInput,
    setIdentityInput,
    participantInfo,
    settingsOpen,
    setSettingsOpen,
    nameInput,
    setNameInput,
    deviceInput,
    setDeviceInput,
    savingSettings,
    registerOpen,
    setRegisterOpen,
    regName,
    setRegName,
    regDevice,
    setRegDevice,
    registering,
    participants,
    participantsLoading,
    participantsError,
    message,
    error,
    settingsMessage,
    settingsError,
    handleSaveIdentity,
    handleClearIdentity,
    handleBind,
    handleRegister,
    handleSaveSettings,
    currentParticipant,
  };
}
