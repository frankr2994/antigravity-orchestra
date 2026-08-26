import { useMemo, useReducer, type Dispatch, type SetStateAction } from 'react';
import type { Message, Project, Session, Task, TaskEvent } from './types';

export interface WorkspaceState {
  projects: Project[];
  project: Project | null;
  sessions: Session[];
  session: Session | null;
  messages: Message[];
  tasks: Task[];
  activeTask: Task | null;
  projectOwnerTask: Task | null;
  activity: TaskEvent[];
}

export const initialWorkspaceState: WorkspaceState = {
  projects: [], project: null, sessions: [], session: null, messages: [], tasks: [], activeTask: null, projectOwnerTask: null, activity: [],
};

export type WorkspaceAction =
  | { type: 'set'; key: keyof WorkspaceState; value: unknown }
  | { type: 'open-session'; session: Session; messages?: Message[]; task?: Task | null; activity?: TaskEvent[] }
  | { type: 'new-conversation'; session: Session };

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  if (action.type === 'open-session') return { ...state, session: action.session, messages: action.messages ?? [], activeTask: action.task ?? null, activity: action.activity ?? [] };
  if (action.type === 'new-conversation') return { ...state, sessions: [action.session, ...state.sessions.filter((item) => item.id !== action.session.id)], session: action.session, messages: [], activeTask: null, activity: [] };
  const current = state[action.key];
  const next = typeof action.value === 'function' ? (action.value as (value: typeof current) => typeof current)(current) : action.value;
  return { ...state, [action.key]: next } as WorkspaceState;
}

type WorkspaceSetters = { [K in keyof WorkspaceState as `set${Capitalize<K>}`]: Dispatch<SetStateAction<WorkspaceState[K]>> };

export function useWorkspaceState(): [WorkspaceState, WorkspaceSetters & { openSession: (session: Session, messages?: Message[], task?: Task | null, activity?: TaskEvent[]) => void; newConversation: (session: Session) => void }] {
  const [state, dispatch] = useReducer(workspaceReducer, initialWorkspaceState);
  const actions = useMemo(() => {
    const setter = <K extends keyof WorkspaceState>(key: K) => (value: SetStateAction<WorkspaceState[K]>) => dispatch({ type: 'set', key, value });
    return {
      setProjects: setter('projects'), setProject: setter('project'), setSessions: setter('sessions'), setSession: setter('session'), setMessages: setter('messages'), setTasks: setter('tasks'), setActiveTask: setter('activeTask'), setProjectOwnerTask: setter('projectOwnerTask'), setActivity: setter('activity'),
      openSession: (session: Session, messages: Message[] = [], task: Task | null = null, activity: TaskEvent[] = []) => dispatch({ type: 'open-session', session, messages, task, activity }),
      newConversation: (session: Session) => dispatch({ type: 'new-conversation', session }),
    };
  }, []);
  return [state, actions];
}
