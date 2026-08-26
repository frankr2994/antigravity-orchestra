import { useState } from 'react';

export function useComposerState() {
  const [input, setInput] = useState('');
  const [executionMode, setExecutionMode] = useState<'orchestra' | 'direct'>('orchestra');
  const [executionTarget, setExecutionTarget] = useState<'local' | 'cloud' | 'auto'>('local');
  const [directAgent, setDirectAgent] = useState<'gemma' | 'antigravity' | 'codex'>('gemma');
  const [soloAntigravityModel, setSoloAntigravityModel] = useState('gemini-3.7-flash-high');
  const [soloCodexModel, setSoloCodexModel] = useState('gpt-5.6-sol');
  const [soloCodexEffort, setSoloCodexEffort] = useState('high');
  const [soloGemmaModel, setSoloGemmaModel] = useState('');
  return {
    input, setInput, executionMode, setExecutionMode, executionTarget, setExecutionTarget,
    directAgent, setDirectAgent, soloAntigravityModel, setSoloAntigravityModel,
    soloCodexModel, setSoloCodexModel, soloCodexEffort, setSoloCodexEffort,
    soloGemmaModel, setSoloGemmaModel,
  };
}
