// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api } from '../api';
import type { ModelDescriptor, UserConfig } from '../api';
import type { SettingsBackup } from '../types';
import { gameBridge } from '../game/gameBridge';
import { interactionLogger } from '../utils/interactionLogger';

export interface SettingsState {
  configFilePath: string;
  setConfigFilePath: (v: string) => void;
  lastActiveConfigFilePath: string;
  changeConfigFilePath: (newPath: string) => Promise<UserConfig>;
  configRequestFromUserConfig: (cfg: UserConfig) => ReturnType<SettingsState['buildConfigRequest']>;

  networkPath: string;
  setNetworkPath: (v: string) => void;
  actionPath: string;
  setActionPath: (v: string) => void;
  layoutPath: string;
  setLayoutPath: (v: string) => void;
  outputFolderPath: string;
  setOutputFolderPath: (v: string) => void;

  minLineReconnections: number;
  setMinLineReconnections: (v: number) => void;
  minCloseCoupling: number;
  setMinCloseCoupling: (v: number) => void;
  minOpenCoupling: number;
  setMinOpenCoupling: (v: number) => void;
  minLineDisconnections: number;
  setMinLineDisconnections: (v: number) => void;
  nPrioritizedActions: number;
  setNPrioritizedActions: (v: number) => void;
  minPst: number;
  setMinPst: (v: number) => void;
  minLoadShedding: number;
  setMinLoadShedding: (v: number) => void;
  minRenewableCurtailmentActions: number;
  setMinRenewableCurtailmentActions: (v: number) => void;
  minRedispatch: number;
  setMinRedispatch: (v: number) => void;
  allowedActionTypes: string[];
  setAllowedActionTypes: (v: string[]) => void;
  ignoreReconnections: boolean;
  setIgnoreReconnections: (v: boolean) => void;
  recommenderModel: string;
  setRecommenderModel: (v: string) => void;
  computeOverflowGraph: boolean;
  setComputeOverflowGraph: (v: boolean) => void;
  availableModels: ModelDescriptor[];

  linesMonitoringPath: string;
  setLinesMonitoringPath: (v: string) => void;
  monitoredLinesCount: number;
  setMonitoredLinesCount: (v: number) => void;
  totalLinesCount: number;
  setTotalLinesCount: (v: number) => void;
  showMonitoringWarning: boolean;
  setShowMonitoringWarning: (v: boolean) => void;
  monitoringFactor: number;
  setMonitoringFactor: (v: number) => void;
  preExistingOverloadThreshold: number;
  setPreExistingOverloadThreshold: (v: number) => void;
  pypowsyblFastMode: boolean;
  setPypowsyblFastMode: (v: boolean) => void;

  actionDictFileName: string | null;
  setActionDictFileName: (v: string | null) => void;
  actionDictStats: { reco: number; disco: number; pst: number; open_coupling: number; close_coupling: number; total: number } | null;
  setActionDictStats: (v: { reco: number; disco: number; pst: number; open_coupling: number; close_coupling: number; total: number } | null) => void;

  isSettingsOpen: boolean;
  setIsSettingsOpen: (v: boolean) => void;
  settingsTab: 'recommender' | 'configurations' | 'paths';
  setSettingsTab: (v: 'recommender' | 'configurations' | 'paths') => void;
  settingsBackup: SettingsBackup | null;
  setSettingsBackup: (v: SettingsBackup | null) => void;

  pickSettingsPath: (type: 'file' | 'dir', setter: (path: string) => void) => Promise<void>;
  handleOpenSettings: (tab?: 'recommender' | 'configurations' | 'paths') => void;
  handleCloseSettings: () => void;
  buildConfigRequest: () => {
    network_path: string;
    action_file_path: string;
    layout_path: string;
    min_line_reconnections: number;
    min_close_coupling: number;
    min_open_coupling: number;
    min_line_disconnections: number;
    min_pst: number;
    min_load_shedding: number;
    min_renewable_curtailment_actions: number;
    min_redispatch: number;
    allowed_action_types: string[];
    n_prioritized_actions: number;
    lines_monitoring_path: string;
    monitoring_factor: number;
    pre_existing_overload_threshold: number;
    ignore_reconnections: boolean;
    pypowsybl_fast_mode: boolean;
    model: string;
    compute_overflow_graph: boolean;
  };
  applyConfigResponse: (configRes: Record<string, unknown>) => void;
  createCurrentBackup: () => SettingsBackup;
}

export function useSettings(): SettingsState {
  const [configFilePath, setConfigFilePath] = useState('');
  const lastConfigFilePathRef = useRef('');

  const [networkPath, setNetworkPath] = useState(localStorage.getItem('networkPath') || '');
  const [actionPath, setActionPath] = useState(localStorage.getItem('actionPath') || '');
  const [layoutPath, setLayoutPath] = useState(localStorage.getItem('layoutPath') || '');
  const [outputFolderPath, setOutputFolderPath] = useState(localStorage.getItem('outputFolderPath') || '');

  const [minLineReconnections, setMinLineReconnections] = useState(2.0);
  const [minCloseCoupling, setMinCloseCoupling] = useState(3.0);
  const [minOpenCoupling, setMinOpenCoupling] = useState(2.0);
  const [minLineDisconnections, setMinLineDisconnections] = useState(3.0);
  const [nPrioritizedActions, setNPrioritizedActions] = useState(10);
  const [minPst, setMinPst] = useState(1.0);
  const [minLoadShedding, setMinLoadShedding] = useState(0.0);
  const [minRenewableCurtailmentActions, setMinRenewableCurtailmentActions] = useState(0.0);
  const [minRedispatch, setMinRedispatch] = useState(0.0);
  const [allowedActionTypes, setAllowedActionTypes] = useState<string[]>([]);
  const [ignoreReconnections, setIgnoreReconnections] = useState(false);

  const [recommenderModel, setRecommenderModel] = useState<string>(localStorage.getItem('recommenderModel') || 'expert');
  const [computeOverflowGraph, setComputeOverflowGraph] = useState<boolean>(
    (localStorage.getItem('computeOverflowGraph') ?? 'true') !== 'false'
  );
  const [availableModels, setAvailableModels] = useState<ModelDescriptor[]>([]);

  const [linesMonitoringPath, setLinesMonitoringPath] = useState('');
  const [monitoredLinesCount, setMonitoredLinesCount] = useState(0);
  const [totalLinesCount, setTotalLinesCount] = useState(0);
  const [showMonitoringWarning, setShowMonitoringWarning] = useState(false);
  const [monitoringFactor, setMonitoringFactor] = useState(0.95);
  const [preExistingOverloadThreshold, setPreExistingOverloadThreshold] = useState(0.02);
  const [pypowsyblFastMode, setPypowsyblFastMode] = useState(true);

  const [actionDictFileName, setActionDictFileName] = useState<string | null>(null);
  const [actionDictStats, setActionDictStats] = useState<{ reco: number; disco: number; pst: number; open_coupling: number; close_coupling: number; total: number } | null>(null);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'recommender' | 'configurations' | 'paths'>('paths');
  const [settingsBackup, setSettingsBackup] = useState<SettingsBackup | null>(null);

  const configLoadedRef = useRef(false);

  const applyLoadedConfig = useCallback((cfg: UserConfig) => {
    // In Game Mode the active STUDY dictates the network / action / layout /
    // monitoring paths — `loadGameStudy` sets them. This boot hydration is
    // async and would otherwise race that loader: `config.json` ships the
    // bundled fr225_400 default, so applying its paths here overwrites the
    // study's grid in the path field (and Settings) while the study's grid is
    // the one actually loaded. Skip the grid paths in game mode; the
    // recommender minima below still come from the persisted config.
    if (!gameBridge.isGameMode()) {
      if (cfg.network_path !== undefined) setNetworkPath(cfg.network_path);
      if (cfg.action_file_path !== undefined) setActionPath(cfg.action_file_path);
      if (cfg.layout_path !== undefined) setLayoutPath(cfg.layout_path);
      if (cfg.lines_monitoring_path !== undefined) setLinesMonitoringPath(cfg.lines_monitoring_path);
    }
    if (cfg.output_folder_path !== undefined) setOutputFolderPath(cfg.output_folder_path);
    if (cfg.min_line_reconnections !== undefined) setMinLineReconnections(cfg.min_line_reconnections);
    if (cfg.min_close_coupling !== undefined) setMinCloseCoupling(cfg.min_close_coupling);
    if (cfg.min_open_coupling !== undefined) setMinOpenCoupling(cfg.min_open_coupling);
    if (cfg.min_line_disconnections !== undefined) setMinLineDisconnections(cfg.min_line_disconnections);
    if (cfg.min_pst !== undefined) setMinPst(cfg.min_pst);
    if (cfg.min_load_shedding !== undefined) setMinLoadShedding(cfg.min_load_shedding);
    if (cfg.min_renewable_curtailment_actions !== undefined) setMinRenewableCurtailmentActions(cfg.min_renewable_curtailment_actions);
    if (cfg.min_redispatch !== undefined) setMinRedispatch(cfg.min_redispatch);
    if (cfg.allowed_action_types !== undefined) setAllowedActionTypes(cfg.allowed_action_types ?? []);
    if (cfg.n_prioritized_actions !== undefined) setNPrioritizedActions(cfg.n_prioritized_actions);
    if (cfg.monitoring_factor !== undefined) setMonitoringFactor(cfg.monitoring_factor);
    if (cfg.pre_existing_overload_threshold !== undefined) setPreExistingOverloadThreshold(cfg.pre_existing_overload_threshold);
    if (cfg.ignore_reconnections !== undefined) setIgnoreReconnections(cfg.ignore_reconnections);
    if (cfg.pypowsybl_fast_mode !== undefined) setPypowsyblFastMode(cfg.pypowsybl_fast_mode);
    if (cfg.model !== undefined && cfg.model) setRecommenderModel(cfg.model);
    if (cfg.compute_overflow_graph !== undefined) setComputeOverflowGraph(cfg.compute_overflow_graph);
  }, []);

  useEffect(() => {
    Promise.all([api.getUserConfig(), api.getConfigFilePath()])
      .then(([cfg, cfgPath]) => {
        applyLoadedConfig(cfg);
        setConfigFilePath(cfgPath);
        lastConfigFilePathRef.current = cfgPath;
        configLoadedRef.current = true;
      })
      .catch(() => {
        console.warn('Failed to load user config from backend, using defaults');
        configLoadedRef.current = true;
      });
    // Guard against test stubs of the `api` module that don't define
    // `getModels` (most pre-existing test suites only mock the methods
    // they exercise). Without this check the effect throws
    // `api.getModels is not a function` on first render and the whole
    // App tree fails to mount.
    if (typeof api.getModels === 'function') {
      api.getModels()
        .then(({ models }) => setAvailableModels(models))
        .catch(() => {
          console.warn('Failed to load recommender models, using static defaults');
          setAvailableModels([{
            name: 'expert', label: 'Expert system',
            requires_overflow_graph: true, is_default: true, params: [],
          }]);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep ``computeOverflowGraph`` consistent with the active model's
  // ``requires_overflow_graph`` flag: when the operator switches to a
  // model that needs the graph, force the toggle on so the saved
  // user-config matches what the backend will actually do. The UI also
  // greys out the checkbox for these models — this effect is the
  // belt-and-suspenders that makes sure persisted state stays correct
  // when the user toggled it off on a previous (non-requiring) model and
  // then picked a requiring one.
  useEffect(() => {
    if (!availableModels.length) return;
    const active = availableModels.find(m => m.name === recommenderModel);
    if (active?.requires_overflow_graph && !computeOverflowGraph) {
      setComputeOverflowGraph(true);
    }
  }, [recommenderModel, availableModels, computeOverflowGraph]);

  // Push the active recommender model to the running RecommenderService
  // whenever the operator changes it (from Settings OR from the new
  // dropdown above the Analyze & Suggest button). Without this the
  // backend keeps the previously-applied model (set on /api/config) and
  // a re-run produces suggestions from the OLD model regardless of
  // the dropdown choice. Cheap: the endpoint only updates two
  // attributes — no network reload, no action dictionary rebuild.
  const lastPushedModelRef = useRef<{ model: string; computeOverflowGraph: boolean } | null>(null);
  useEffect(() => {
    if (!configLoadedRef.current) return;
    const last = lastPushedModelRef.current;
    if (last && last.model === recommenderModel && last.computeOverflowGraph === computeOverflowGraph) return;
    lastPushedModelRef.current = { model: recommenderModel, computeOverflowGraph };
    if (typeof api.setRecommenderModel !== 'function') return;
    api.setRecommenderModel(recommenderModel, computeOverflowGraph).catch(err => {
      console.warn('Failed to push recommender-model to backend', err);
    });
  }, [recommenderModel, computeOverflowGraph]);

  const changeConfigFilePath = useCallback(async (newPath: string): Promise<UserConfig> => {
    const result = await api.setConfigFilePath(newPath);
    setConfigFilePath(result.config_file_path);
    lastConfigFilePathRef.current = result.config_file_path;
    configLoadedRef.current = false;
    applyLoadedConfig(result.config);
    configLoadedRef.current = true;
    return result.config;
  }, [applyLoadedConfig]);

  const configRequestFromUserConfig = useCallback((cfg: UserConfig) => ({
    network_path: cfg.network_path,
    action_file_path: cfg.action_file_path,
    layout_path: cfg.layout_path ?? '',
    min_line_reconnections: cfg.min_line_reconnections,
    min_close_coupling: cfg.min_close_coupling,
    min_open_coupling: cfg.min_open_coupling,
    min_line_disconnections: cfg.min_line_disconnections,
    min_pst: cfg.min_pst,
    min_load_shedding: cfg.min_load_shedding,
    min_renewable_curtailment_actions: cfg.min_renewable_curtailment_actions,
    min_redispatch: cfg.min_redispatch,
    allowed_action_types: cfg.allowed_action_types ?? [],
    n_prioritized_actions: cfg.n_prioritized_actions,
    lines_monitoring_path: cfg.lines_monitoring_path ?? '',
    monitoring_factor: cfg.monitoring_factor,
    pre_existing_overload_threshold: cfg.pre_existing_overload_threshold,
    ignore_reconnections: cfg.ignore_reconnections,
    pypowsybl_fast_mode: cfg.pypowsybl_fast_mode,
    model: cfg.model ?? 'expert',
    compute_overflow_graph: cfg.compute_overflow_graph ?? true,
  }), []);

  useEffect(() => {
    if (!configLoadedRef.current) return;
    const configToSave: UserConfig = {
      network_path: networkPath,
      action_file_path: actionPath,
      layout_path: layoutPath,
      output_folder_path: outputFolderPath,
      lines_monitoring_path: linesMonitoringPath,
      min_line_reconnections: minLineReconnections,
      min_close_coupling: minCloseCoupling,
      min_open_coupling: minOpenCoupling,
      min_line_disconnections: minLineDisconnections,
      min_pst: minPst,
      min_load_shedding: minLoadShedding,
      min_renewable_curtailment_actions: minRenewableCurtailmentActions,
      min_redispatch: minRedispatch,
      allowed_action_types: allowedActionTypes,
      n_prioritized_actions: nPrioritizedActions,
      monitoring_factor: monitoringFactor,
      pre_existing_overload_threshold: preExistingOverloadThreshold,
      ignore_reconnections: ignoreReconnections,
      pypowsybl_fast_mode: pypowsyblFastMode,
      model: recommenderModel,
      compute_overflow_graph: computeOverflowGraph,
    };

    localStorage.setItem('networkPath', networkPath);
    localStorage.setItem('actionPath', actionPath);
    localStorage.setItem('layoutPath', layoutPath);
    localStorage.setItem('outputFolderPath', outputFolderPath);
    localStorage.setItem('recommenderModel', recommenderModel);
    localStorage.setItem('computeOverflowGraph', String(computeOverflowGraph));

    api.saveUserConfig(configToSave).catch(() => {
      console.warn('Failed to persist user config to backend');
    });
  }, [networkPath, actionPath, layoutPath, outputFolderPath, linesMonitoringPath,
    minLineReconnections, minCloseCoupling, minOpenCoupling, minLineDisconnections,
    minPst, minLoadShedding, minRenewableCurtailmentActions, minRedispatch, allowedActionTypes, nPrioritizedActions, monitoringFactor, preExistingOverloadThreshold,
    ignoreReconnections, pypowsyblFastMode, recommenderModel, computeOverflowGraph]);

  const pickSettingsPath = useCallback(async (type: 'file' | 'dir', setter: (path: string) => void) => {
    try {
      const path = await api.pickPath(type);
      if (path) {
        interactionLogger.record('path_picked', { type, path });
        setter(path);
      }
    } catch (e) {
      const baseMessage = e instanceof Error ? e.message : 'Failed to open file picker';
      const axiosErr = e as { response?: { status?: number }, code?: string };
      const status = axiosErr?.response?.status;
      const isNetworkError = !axiosErr?.response && (axiosErr?.code === 'ERR_NETWORK' || /Network Error/i.test(baseMessage));
      const isMissingEndpoint = status === 404;
      const hint = (isNetworkError || isMissingEndpoint)
        ? '\n\nIs the Co-Study4Grid backend running on http://127.0.0.1:8000? '
            + 'If it is, it may be an outdated instance — restart it after pulling the latest code.'
        : '';
      console.error('Failed to open file picker:', e);
      alert(
        `Unable to open the native file picker:\n${baseMessage}${hint}\n\n` +
        'Paste the path into the text field manually instead.'
      );
    }
  }, []);

  const createCurrentBackup = useCallback((): SettingsBackup => ({
    networkPath,
    actionPath,
    layoutPath,
    outputFolderPath,
    minLineReconnections,
    minCloseCoupling,
    minOpenCoupling,
    minLineDisconnections,
    minLoadShedding,
    minRenewableCurtailmentActions,
    minRedispatch,
    allowedActionTypes,
    nPrioritizedActions,
    linesMonitoringPath,
    monitoringFactor,
    preExistingOverloadThreshold,
    ignoreReconnections,
    pypowsyblFastMode,
  }), [networkPath, actionPath, layoutPath, outputFolderPath, minLineReconnections, minCloseCoupling, minOpenCoupling, minLineDisconnections, minLoadShedding, minRenewableCurtailmentActions, minRedispatch, allowedActionTypes, nPrioritizedActions, linesMonitoringPath, monitoringFactor, preExistingOverloadThreshold, ignoreReconnections, pypowsyblFastMode]);

  const handleOpenSettings = useCallback((tab: 'recommender' | 'configurations' | 'paths' = 'paths') => {
    interactionLogger.record('settings_opened', { tab });
    setSettingsBackup(createCurrentBackup());
    setSettingsTab(tab);
    setIsSettingsOpen(true);
  }, [createCurrentBackup]);

  const handleCloseSettings = useCallback(() => {
    interactionLogger.record('settings_cancelled');
    if (settingsBackup) {
      if (settingsBackup.networkPath !== undefined) setNetworkPath(settingsBackup.networkPath);
      if (settingsBackup.actionPath !== undefined) setActionPath(settingsBackup.actionPath);
      if (settingsBackup.layoutPath !== undefined) setLayoutPath(settingsBackup.layoutPath);
      if (settingsBackup.outputFolderPath !== undefined) setOutputFolderPath(settingsBackup.outputFolderPath);
      setMinLineReconnections(settingsBackup.minLineReconnections);
      setMinCloseCoupling(settingsBackup.minCloseCoupling);
      setMinOpenCoupling(settingsBackup.minOpenCoupling);
      setMinLineDisconnections(settingsBackup.minLineDisconnections);
      setMinLoadShedding(settingsBackup.minLoadShedding ?? 0.0);
      setMinRenewableCurtailmentActions(settingsBackup.minRenewableCurtailmentActions ?? 0.0);
      setMinRedispatch(settingsBackup.minRedispatch ?? 0.0);
      setAllowedActionTypes(settingsBackup.allowedActionTypes ?? []);
      setNPrioritizedActions(settingsBackup.nPrioritizedActions);
      setLinesMonitoringPath(settingsBackup.linesMonitoringPath);
      setMonitoringFactor(settingsBackup.monitoringFactor);
      setPreExistingOverloadThreshold(settingsBackup.preExistingOverloadThreshold);
      setIgnoreReconnections(settingsBackup.ignoreReconnections ?? false);
      setPypowsyblFastMode(settingsBackup.pypowsyblFastMode ?? true);
    }
    setIsSettingsOpen(false);
  }, [settingsBackup]);

  const buildConfigRequest = useCallback(() => ({
    network_path: networkPath,
    action_file_path: actionPath,
    layout_path: layoutPath,
    min_line_reconnections: minLineReconnections,
    min_close_coupling: minCloseCoupling,
    min_open_coupling: minOpenCoupling,
    min_line_disconnections: minLineDisconnections,
    min_pst: minPst,
    min_load_shedding: minLoadShedding,
    min_renewable_curtailment_actions: minRenewableCurtailmentActions,
    min_redispatch: minRedispatch,
    allowed_action_types: allowedActionTypes,
    n_prioritized_actions: nPrioritizedActions,
    lines_monitoring_path: linesMonitoringPath,
    monitoring_factor: monitoringFactor,
    pre_existing_overload_threshold: preExistingOverloadThreshold,
    ignore_reconnections: ignoreReconnections,
    pypowsybl_fast_mode: pypowsyblFastMode,
    model: recommenderModel,
    compute_overflow_graph: computeOverflowGraph,
  }), [networkPath, actionPath, layoutPath, minLineReconnections, minCloseCoupling, minOpenCoupling, minLineDisconnections, minPst, minLoadShedding, minRenewableCurtailmentActions, minRedispatch, allowedActionTypes, nPrioritizedActions, linesMonitoringPath, monitoringFactor, preExistingOverloadThreshold, ignoreReconnections, pypowsyblFastMode, recommenderModel, computeOverflowGraph]);

  const applyConfigResponse = useCallback((configRes: Record<string, unknown>) => {
    if (configRes && configRes.total_lines_count !== undefined) {
      setMonitoredLinesCount(configRes.monitored_lines_count as number);
      setTotalLinesCount(configRes.total_lines_count as number);
      if ((configRes.monitored_lines_count as number) < (configRes.total_lines_count as number)) {
        setShowMonitoringWarning(true);
      }
    }
    if (configRes?.action_dict_file_name) setActionDictFileName(configRes.action_dict_file_name as string);
    if (configRes?.action_dict_stats) setActionDictStats(configRes.action_dict_stats as { reco: number; disco: number; pst: number; open_coupling: number; close_coupling: number; total: number });
  }, []);

  return useMemo(() => ({
    configFilePath, setConfigFilePath, changeConfigFilePath, lastActiveConfigFilePath: lastConfigFilePathRef.current,
    networkPath, setNetworkPath,
    actionPath, setActionPath,
    layoutPath, setLayoutPath,
    outputFolderPath, setOutputFolderPath,
    minLineReconnections, setMinLineReconnections,
    minCloseCoupling, setMinCloseCoupling,
    minOpenCoupling, setMinOpenCoupling,
    minLineDisconnections, setMinLineDisconnections,
    nPrioritizedActions, setNPrioritizedActions,
    minPst, setMinPst,
    minLoadShedding, setMinLoadShedding,
    minRenewableCurtailmentActions, setMinRenewableCurtailmentActions,
    minRedispatch, setMinRedispatch,
    allowedActionTypes, setAllowedActionTypes,
    ignoreReconnections, setIgnoreReconnections,
    recommenderModel, setRecommenderModel,
    computeOverflowGraph, setComputeOverflowGraph,
    availableModels,
    linesMonitoringPath, setLinesMonitoringPath,
    monitoredLinesCount, setMonitoredLinesCount,
    totalLinesCount, setTotalLinesCount,
    showMonitoringWarning, setShowMonitoringWarning,
    monitoringFactor, setMonitoringFactor,
    preExistingOverloadThreshold, setPreExistingOverloadThreshold,
    pypowsyblFastMode, setPypowsyblFastMode,
    actionDictFileName, setActionDictFileName,
    actionDictStats, setActionDictStats,
    isSettingsOpen, setIsSettingsOpen,
    settingsTab, setSettingsTab,
    settingsBackup, setSettingsBackup,
    pickSettingsPath,
    handleOpenSettings,
    handleCloseSettings,
    buildConfigRequest,
    configRequestFromUserConfig,
    applyConfigResponse,
    createCurrentBackup,
  }), [
    networkPath, actionPath, layoutPath, outputFolderPath,
    minLineReconnections, minCloseCoupling, minOpenCoupling, minLineDisconnections,
    nPrioritizedActions, minPst, minLoadShedding, minRenewableCurtailmentActions, minRedispatch, allowedActionTypes, ignoreReconnections,
    recommenderModel, computeOverflowGraph, availableModels,
    linesMonitoringPath, monitoredLinesCount, totalLinesCount, showMonitoringWarning, monitoringFactor, preExistingOverloadThreshold, pypowsyblFastMode,
    actionDictFileName, actionDictStats,
    isSettingsOpen, settingsTab, settingsBackup,
    configFilePath, changeConfigFilePath,
    pickSettingsPath, handleOpenSettings, handleCloseSettings, buildConfigRequest, configRequestFromUserConfig, applyConfigResponse, createCurrentBackup
  ]);
}
