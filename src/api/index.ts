// Single entry point for the API. Components import from here.
//   npm run dev        -> real controller API (proxied, see vite.config.ts)
//   npm run dev:mock   -> in-memory mock, no controller needed
//   production build   -> real API
import * as mock from './mockApi';
import * as real from './realApi';

const useMock = import.meta.env.VITE_API === 'mock';
if (useMock) mock.startSimulation();

const impl: typeof real = useMock ? (mock as unknown as typeof real) : real;

export const login = impl.login;
export const fetchPorts = impl.fetchPorts;
export const fetchIO = impl.fetchIO;
export const fetchEthernet = impl.fetchEthernet;
export const setRelay = impl.setRelay;
export const fetchRs485Log = impl.fetchRs485Log;
export const sendRs485 = impl.sendRs485;
export const fetchScenarioStatus = impl.fetchScenarioStatus;
export const fetchModuleConfig = impl.fetchModuleConfig;
export const saveModuleConfig = impl.saveModuleConfig;
export const fetchRegisterTable = impl.fetchRegisterTable;
export const saveRegisterTable = impl.saveRegisterTable;
export const fetchScenarios = impl.fetchScenarios;
export const saveScenario = impl.saveScenario;
export const startScenario = impl.startScenario;
export const stopScenario = impl.stopScenario;
export const fetchSystemInfo = impl.fetchSystemInfo;
export const fetchSystemHistory = impl.fetchSystemHistory;
export const subscribeLive = impl.subscribeLive;
