import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { FleetTelemetryProjection } from '../../core/src/fleetTelemetry.js';
import { toMajorMinor } from './changelogData.js';
import { BottomToolbar } from './components/BottomToolbar.js';
import { ChangelogModal } from './components/ChangelogModal.js';
import { ConnectionIndicator } from './components/ConnectionIndicator.js';
import { DebugView } from './components/DebugView.js';
import { EditActionBar } from './components/EditActionBar.js';
import { MigrationNotice } from './components/MigrationNotice.js';
import { SettingsModal } from './components/SettingsModal.js';
import { Tooltip } from './components/Tooltip.js';
import { Modal } from './components/ui/Modal.js';
import { VersionIndicator } from './components/VersionIndicator.js';
import { ZoomControls } from './components/ZoomControls.js';
import { TaskControlCenter } from './control/TaskControlCenter.js';
import { FleetCommand, type FleetCommandAction } from './fleet/FleetCommand.js';
import type { FleetCharacterMetadata } from './fleet/model.js';
import { buildFleetSceneModel } from './fleet/model.js';
import {
  PRODUCT_DEFAULT_SCENE,
  readDefaultScenePreference,
  readPersistedScenePreference,
  type SceneId,
  writeDefaultScenePreference,
  writeScenePreference,
} from './fleet/scene.js';
import { useEditorActions } from './hooks/useEditorActions.js';
import { useEditorKeyboard } from './hooks/useEditorKeyboard.js';
import { useExtensionMessages } from './hooks/useExtensionMessages.js';
import { getActivityText } from './office/components/agentStatus.js';
import { OfficeAgentDetail } from './office/components/OfficeAgentDetail.js';
import { OfficeCanvas } from './office/components/OfficeCanvas.js';
import { ToolOverlay } from './office/components/ToolOverlay.js';
import { EditorState } from './office/editor/editorState.js';
import { EditorToolbar } from './office/editor/EditorToolbar.js';
import { OfficeState } from './office/engine/officeState.js';
import { exportLayoutToFile } from './office/layout/exportLayout.js';
import { isRotatable } from './office/layout/furnitureCatalog.js';
import { migrateLayoutColors } from './office/layout/layoutSerializer.js';
import { getPetCount } from './office/sprites/petSpriteData.js';
import { EditTool, type OfficeLayout } from './office/types.js';
import { isBrowserRuntime, isE2E } from './runtime.js';
import { installTestHooks } from './testHooks.js';
import { transport } from './transport/index.js';

// Game state lives outside React — updated imperatively by message handlers
const officeStateRef = { current: null as OfficeState | null };
const editorState = new EditorState();

// Test-only observability hooks (message/sound logs, addAgent wrapper, selectAgent).
// Installed only under the e2e harness so they never patch prototypes or grow
// unbounded logs in a real user's session.
if (isE2E) installTestHooks(officeStateRef);

function getOfficeState(): OfficeState {
  if (!officeStateRef.current) {
    officeStateRef.current = new OfficeState();
  }
  return officeStateRef.current;
}

function App() {
  // Browser runtime (dev or static dist): dispatch mock messages after the
  // useExtensionMessages listener has been registered.
  useEffect(() => {
    // browserMock is for Vite dev mode only (UI prototyping without a server).
    // In standalone server mode, the server sends all state over WebSocket.
    // In VS Code mode, the extension sends all state via postMessage.
    if (isBrowserRuntime && import.meta.env.DEV) {
      void import('./browserMock.js').then(({ dispatchMockMessages }) => dispatchMockMessages());
    }
  }, []);

  const editor = useEditorActions(getOfficeState, editorState);

  const isEditDirty = useCallback(
    () => editor.isEditMode && editor.isDirty,
    [editor.isEditMode, editor.isDirty],
  );

  const {
    agents,
    selectedAgent,
    agentTools,
    agentStatuses,
    agentInfo,
    subagentTools,
    subagentCharacters,
    layoutReady,
    layoutWasReset,
    loadedAssets,
    workspaceFolders,
    agentFolderNames,
    externalAssetDirectories,
    lastSeenVersion,
    extensionVersion,
    watchAllSessions,
    setWatchAllSessions,
    alwaysShowLabels,
    ghostHeadlessAgents,
    setGhostHeadlessAgents,
    hooksEnabled,
    setHooksEnabled,
    hooksInfoShown,
    areaMappings,
    setAreaMappings,
    showAreas,
    setShowAreas,
  } = useExtensionMessages(getOfficeState, editor.setLastSavedLayout, isEditDirty);

  const [scene, setScene] = useState<SceneId>(() => {
    try {
      return readPersistedScenePreference(
        typeof window === 'undefined' ? null : window.localStorage,
      );
    } catch {
      return PRODUCT_DEFAULT_SCENE;
    }
  });
  const [defaultScene, setDefaultScene] = useState<SceneId>(() => {
    try {
      return readDefaultScenePreference(typeof window === 'undefined' ? null : window.localStorage);
    } catch {
      return PRODUCT_DEFAULT_SCENE;
    }
  });
  const [telemetry, setTelemetry] = useState<FleetTelemetryProjection>({
    snapshots: [],
    recentEvents: [],
  });
  // Fleet Command selection is a UI projection only. Runtime ownership and
  // lifecycle remain in useExtensionMessages/OfficeState.
  const [fleetSelection, setFleetSelection] = useState<number | null>(null);
  const [officeSelection, setOfficeSelection] = useState<number | null>(null);

  // Consume the existing normalized telemetry projection as presentation data.
  // Agent lifecycle and roster ownership remain with useExtensionMessages and
  // OfficeState; this does not create a second Agent state source.
  useEffect(() => {
    return transport.onMessage((msg) => {
      // fleetTelemetry is an existing adapter broadcast; the older shared
      // ServerMessage union does not yet include this projection type.
      const message = msg as unknown as {
        type: string;
        projection?: FleetTelemetryProjection;
      };
      if (message.type !== 'fleetTelemetry') return;
      const projection = message.projection;
      if (!projection || !Array.isArray(projection.snapshots)) return;
      setTelemetry({
        snapshots: projection.snapshots,
        recentEvents: Array.isArray(projection.recentEvents) ? projection.recentEvents : [],
      });
    });
  }, []);

  const handleSceneChange = useCallback((nextScene: SceneId) => {
    setScene(nextScene);
    try {
      writeScenePreference(window.localStorage, nextScene);
    } catch {
      writeScenePreference(null, nextScene);
    }
  }, []);

  const handleDefaultSceneChange = useCallback(
    (nextScene: SceneId) => {
      setDefaultScene(nextScene);
      try {
        writeDefaultScenePreference(window.localStorage, nextScene);
      } catch {
        writeDefaultScenePreference(null, nextScene);
      }
      // Make a default choice immediately visible; it is also the projection
      // the next webview session will restore.
      handleSceneChange(nextScene);
    },
    [handleSceneChange],
  );

  // Show migration notice once layout reset is detected
  const [migrationNoticeDismissed, setMigrationNoticeDismissed] = useState(false);
  const showMigrationNotice = layoutWasReset && !migrationNoticeDismissed;

  const [isChangelogOpen, setIsChangelogOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHooksInfoOpen, setIsHooksInfoOpen] = useState(false);
  const [hooksTooltipDismissed, setHooksTooltipDismissed] = useState(false);
  const [isDebugMode, setIsDebugMode] = useState(false);
  const [alwaysShowOverlay, setAlwaysShowOverlay] = useState(false);

  const currentMajorMinor = toMajorMinor(extensionVersion);

  const handleWhatsNewDismiss = useCallback(() => {
    transport.send({ type: 'setLastSeenVersion', version: currentMajorMinor });
  }, [currentMajorMinor]);

  const handleOpenChangelog = useCallback(() => {
    setIsChangelogOpen(true);
    transport.send({ type: 'setLastSeenVersion', version: currentMajorMinor });
  }, [currentMajorMinor]);

  // Sync alwaysShowOverlay from persisted settings
  useEffect(() => {
    setAlwaysShowOverlay(alwaysShowLabels);
  }, [alwaysShowLabels]);

  const handleToggleDebugMode = useCallback(() => setIsDebugMode((prev) => !prev), []);
  const handleToggleAlwaysShowOverlay = useCallback(() => {
    setAlwaysShowOverlay((prev) => {
      const newVal = !prev;
      transport.send({ type: 'setAlwaysShowLabels', enabled: newVal });
      return newVal;
    });
  }, []);

  // Toggle "Display headless as ghosts". setGhostHeadlessAgents also updates the
  // renderer's module copy, so the office redraws on the next frame.
  const handleToggleGhostHeadlessAgents = useCallback(() => {
    const next = !ghostHeadlessAgents;
    setGhostHeadlessAgents(next);
    transport.send({ type: 'setGhostHeadlessAgents', enabled: next });
  }, [ghostHeadlessAgents, setGhostHeadlessAgents]);

  const handleSelectAgent = useCallback((id: number) => {
    setFleetSelection(id);
    transport.send({ type: 'focusAgent', id });
  }, []);

  const handleSelectFleetAgent = useCallback((id: number) => {
    setFleetSelection(id);
  }, []);

  // Mutate folder→Area mappings locally + send to server. Updates OfficeState in
  // the same tick so a follow-up agentCreated picks up the new mapping.
  const handleAreaMappingChange = useCallback(
    (folderName: string, areaLabel: string, action: 'add' | 'remove') => {
      const current = areaMappings[folderName] ?? [];
      let nextLabels: string[];
      if (action === 'add') {
        if (current.includes(areaLabel)) return;
        nextLabels = [...current, areaLabel];
      } else {
        nextLabels = current.filter((l) => l !== areaLabel);
      }
      const next = { ...areaMappings };
      if (nextLabels.length === 0) {
        delete next[folderName];
      } else {
        next[folderName] = nextLabels;
      }
      setAreaMappings(next);
      getOfficeState().setAreaMappings(next);
      transport.send({ type: 'saveAreaMappings', mappings: next });
    },
    [areaMappings, setAreaMappings],
  );

  // Toggle global Show Areas — persisted via setShowAreas message; runs server-
  // side through configPersistence.
  const onToggleShowAreas = useCallback(() => {
    const next = !showAreas;
    setShowAreas(next);
    transport.send({ type: 'setShowAreas', enabled: next });
  }, [showAreas, setShowAreas]);

  // When AREA_PAINT is active in the editor, force the overlay on even if the
  // user has toggled Show Areas off globally — they need to see what they're
  // editing. The selected area's overlay is alpha-bumped via activeAreaLabel.
  const isEditingAreas = editor.isEditMode && editorState.activeTool === EditTool.AREA_PAINT;
  const effectiveShowAreas = isEditingAreas || showAreas;
  const activeAreaLabel = isEditingAreas ? editor.selectedAreaLabel : null;

  // e2e: register the component-scoped editor-action drivers + the effective
  // show-areas gate on the test-hooks namespace (module-load installTestHooks
  // can't reach these React callbacks). Bypasses only canvas pixel→tile
  // geometry — the handlers still own undo/dirty/rebuild. Guarded on isE2E.
  useEffect(() => {
    if (!isE2E || typeof window === 'undefined') return;
    const hooks = (window.__pixelAgentsTestHooks ??= {});
    hooks.editorTileAction = (col, row) => editor.handleEditorTileAction(col, row);
    hooks.editorEraseAction = (col, row) => editor.handleEditorEraseAction(col, row);
    hooks.getShowAreas = () => effectiveShowAreas;
  }, [editor.handleEditorTileAction, editor.handleEditorEraseAction, effectiveShowAreas]);

  const containerRef = useRef<HTMLDivElement>(null);

  const [editorTickForKeyboard, setEditorTickForKeyboard] = useState(0);
  useEditorKeyboard(
    editor.isEditMode,
    editorState,
    editor.handleDeleteSelected,
    editor.handleRotateSelected,
    editor.handleToggleState,
    editor.handleUndo,
    editor.handleRedo,
    useCallback(() => setEditorTickForKeyboard((n) => n + 1), []),
    editor.handleToggleEditMode,
  );

  const handleCloseAgent = useCallback((id: number) => {
    transport.send({ type: 'closeAgent', id });
  }, []);

  const handleOfficeClick = useCallback((agentId: number) => {
    getOfficeState().markCompletionViewed(agentId);
    setOfficeSelection(agentId);
  }, []);

  const handleOfficeDoubleClick = useCallback((agentId: number) => {
    getOfficeState().markCompletionViewed(agentId);
    setOfficeSelection(agentId);
    // If clicked agent is a sub-agent, focus the parent's terminal instead
    const os = getOfficeState();
    const meta = os.subagentMeta.get(agentId);
    const focusId = meta ? meta.parentAgentId : agentId;
    transport.send({ type: 'focusAgent', id: focusId });
  }, []);

  const officeState = getOfficeState();

  const fleetAgentFolders = useMemo(() => {
    const folders: Record<number, { name: string; path: string } | undefined> = {};
    for (const id of agents) {
      const folderName = officeState.characters.get(id)?.folderName;
      if (!folderName) {
        folders[id] = undefined;
        continue;
      }
      const workspaceFolder = workspaceFolders.find((folder) => folder.name === folderName);
      folders[id] = { name: folderName, path: workspaceFolder?.path ?? folderName };
    }
    return folders;
  }, [agents, officeState, workspaceFolders]);

  const fleetCharacters = useMemo(() => {
    const characters: Record<number, FleetCharacterMetadata | undefined> = {};
    for (const id of agents) {
      const character = officeState.characters.get(id);
      if (!character) continue;
      characters[id] = {
        folderName: character.folderName,
        createdAt: agentInfo[id]?.createdAt,
        currentTool: character.currentTool,
        isSubagent: character.isSubagent,
        parentAgentId: character.parentAgentId,
        isTeamLead: character.isTeamLead,
        agentName: character.agentName,
        isHeadless: character.isHeadless,
        displayName: character.displayName,
        contextTokens: character.contextTokens,
        maxContextTokens: character.maxContextTokens,
        usageTokens: agentInfo[id]?.usageTokens ?? character.usageTokens,
      };
    }
    return characters;
  }, [agents, agentInfo, officeState]);

  const fleetModel = useMemo(
    () =>
      buildFleetSceneModel({
        agents,
        selectedAgent,
        agentTools,
        agentStatuses,
        agentFolders: fleetAgentFolders,
        characters: fleetCharacters,
        telemetry,
      }),
    [
      agents,
      selectedAgent,
      agentTools,
      agentStatuses,
      fleetAgentFolders,
      fleetCharacters,
      telemetry,
    ],
  );

  const handleFleetAction = useCallback((action: FleetCommandAction, id: number) => {
    transport.send({ type: action, id });
  }, []);

  // Merged set of folders the Areas dropdown can map: real workspace folders plus
  // every distinct folder an agent has run in this session (deduped by name; name
  // is the areaMappings key / seat-bias identity, path is only the React list key).
  const areaFolders = useMemo(() => {
    const byName = new Map<string, { name: string; path: string }>();
    for (const f of workspaceFolders) byName.set(f.name, f);
    for (const name of agentFolderNames) {
      if (!byName.has(name)) byName.set(name, { name, path: name });
    }
    return [...byName.values()];
  }, [workspaceFolders, agentFolderNames]);

  // Areas authoring is available when the layout already defines areas, or when
  // there is at least one mappable folder. Decouples the Areas UI from VS Code
  // multi-root workspaces (fixes single-root VS Code AND standalone, where
  // workspaceFolders is always empty).
  const areasAvailable = (officeState.getLayout().areas?.length ?? 0) > 0 || areaFolders.length > 0;

  const handleExportLayout = useCallback(() => {
    exportLayoutToFile(getOfficeState().getLayout());
  }, []);

  const handleImportLayout = useCallback(
    (file: File) => {
      // Browser-native import (standalone): read + validate + apply directly,
      // bypassing the layoutLoaded message whose dirty guard would skip it.
      if (
        isEditDirty() &&
        !window.confirm('Replace the current layout? Unsaved edits will be lost.')
      ) {
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const imported = JSON.parse(String(reader.result)) as Record<string, unknown>;
          // Match the VS Code guard, plus the furniture-array check VS Code omits
          // (migrate + rebuild iterate furniture and would throw on a non-array).
          if (
            imported.version !== 1 ||
            !Array.isArray(imported.tiles) ||
            !Array.isArray(imported.furniture)
          ) {
            window.alert('Invalid layout file.');
            return;
          }
          const migrated = migrateLayoutColors(imported as unknown as OfficeLayout);
          getOfficeState().rebuildFromLayout(migrated);
          editor.setLastSavedLayout(migrated);
          transport.send({
            type: 'saveLayout',
            layout: migrated as unknown as Record<string, unknown>,
          });
          editor.markClean();
        } catch {
          window.alert('Failed to read or parse layout file.');
        }
      };
      reader.readAsText(file);
    },
    [isEditDirty, editor],
  );

  // Force dependency on editorTickForKeyboard to propagate keyboard-triggered re-renders
  void editorTickForKeyboard;

  // Show "Press R to rotate" hint when a rotatable item is selected or being placed
  const showRotateHint =
    editor.isEditMode &&
    (() => {
      if (editorState.selectedFurnitureUid) {
        const item = officeState
          .getLayout()
          .furniture.find((f) => f.uid === editorState.selectedFurnitureUid);
        if (item && isRotatable(item.type)) return true;
      }
      if (
        editorState.activeTool === EditTool.FURNITURE_PLACE &&
        isRotatable(editorState.selectedFurnitureType)
      ) {
        return true;
      }
      return false;
    })();

  if (!layoutReady) {
    return <div className="w-full h-full flex items-center justify-center ">Loading...</div>;
  }

  return (
    <div ref={containerRef} className="w-full h-full relative overflow-hidden">
      {scene === 'control-center' ? (
        <TaskControlCenter
          model={fleetModel}
          selectedAgent={fleetSelection}
          onSelectAgent={handleSelectFleetAgent}
          onFocusAgent={handleSelectAgent}
          onAction={handleFleetAction}
          onNewAgent={() => transport.send({ type: 'newAgent' })}
          onClearSelection={() => setFleetSelection(null)}
          isSettingsOpen={isSettingsOpen}
          onToggleSettings={() => setIsSettingsOpen((value) => !value)}
        />
      ) : scene === 'fleet-command' ? (
        <FleetCommand
          model={fleetModel}
          selectedAgent={fleetSelection}
          onSelectAgent={handleSelectFleetAgent}
          onFocusAgent={handleSelectAgent}
          onAction={handleFleetAction}
          onNewAgent={() => transport.send({ type: 'newAgent' })}
          onClearSelection={() => setFleetSelection(null)}
          isSettingsOpen={isSettingsOpen}
          onToggleSettings={() => setIsSettingsOpen((value) => !value)}
        />
      ) : (
        <>
          <OfficeCanvas
            officeState={officeState}
            onClick={handleOfficeClick}
            onDoubleClick={handleOfficeDoubleClick}
            isEditMode={editor.isEditMode}
            editorState={editorState}
            onEditorTileAction={editor.handleEditorTileAction}
            onEditorEraseAction={editor.handleEditorEraseAction}
            onEditorSelectionChange={editor.handleEditorSelectionChange}
            onDeleteSelected={editor.handleDeleteSelected}
            onRotateSelected={editor.handleRotateSelected}
            onDragMove={editor.handleDragMove}
            editorTick={editor.editorTick}
            zoom={editor.zoom}
            onZoomChange={editor.handleZoomChange}
            panRef={editor.panRef}
            showAreas={effectiveShowAreas}
            activeAreaLabel={activeAreaLabel}
          />

          {!isDebugMode ? (
            <>
              <ZoomControls zoom={editor.zoom} onZoomChange={editor.handleZoomChange} />

              {/* Vignette overlay */}
              <div
                className="absolute inset-0 pointer-events-none"
                style={{ background: 'var(--vignette)' }}
              />

              {/* Spec 004 — empty state: no agents running */}
              {agents.length === 0 && (
                <div
                  data-testid="empty-state"
                  className="absolute inset-0 z-12 flex flex-col items-center justify-center gap-8 pointer-events-none"
                >
                  <div className="text-3xl font-bold">No agents running</div>
                  <button
                    data-testid="empty-state-new-agent"
                    onClick={() => transport.send({ type: 'newAgent' })}
                    className="pointer-events-auto py-4 px-12 text-xl bg-accent text-white border-2 border-accent rounded-none cursor-pointer shadow-pixel hover:opacity-90"
                  >
                    + New Agent
                  </button>
                  <p className="text-base opacity-80 max-w-140 text-center">
                    Launch a Claude Code instance with its own repo, provider and model.
                  </p>
                </div>
              )}

              {editor.isEditMode && editor.isDirty && (
                <EditActionBar editor={editor} editorState={editorState} />
              )}

              {showRotateHint && (
                <div
                  className="absolute left-1/2 -translate-x-1/2 z-11 bg-accent-bright text-white text-sm py-3 px-8 rounded-none border-2 border-accent shadow-pixel pointer-events-none whitespace-nowrap"
                  style={{ top: editor.isDirty ? 64 : 8 }}
                >
                  Rotate (R)
                </div>
              )}

              {editor.isEditMode &&
                (() => {
                  const selUid = editorState.selectedFurnitureUid;
                  const selColor = selUid
                    ? (officeState.getLayout().furniture.find((f) => f.uid === selUid)?.color ??
                      null)
                    : null;
                  return (
                    <EditorToolbar
                      activeTool={editorState.activeTool}
                      selectedTileType={editorState.selectedTileType}
                      selectedFurnitureType={editorState.selectedFurnitureType}
                      selectedFurnitureUid={selUid}
                      selectedFurnitureColor={selColor}
                      floorColor={editorState.floorColor}
                      wallColor={editorState.wallColor}
                      selectedWallSet={editorState.selectedWallSet}
                      onToolChange={editor.handleToolChange}
                      onTileTypeChange={editor.handleTileTypeChange}
                      onFloorColorChange={editor.handleFloorColorChange}
                      onWallColorChange={editor.handleWallColorChange}
                      onWallSetChange={editor.handleWallSetChange}
                      onSelectedFurnitureColorChange={editor.handleSelectedFurnitureColorChange}
                      pickedFurnitureColor={editorState.pickedFurnitureColor}
                      onPickedFurnitureColorChange={editor.handlePickedFurnitureColorChange}
                      onFurnitureTypeChange={editor.handleFurnitureTypeChange}
                      loadedAssets={loadedAssets}
                      activePetTypes={officeState.getActivePetTypes()}
                      petCount={getPetCount()}
                      onPetToggle={editor.handlePetToggle}
                      carpetVariant={editor.carpetVariant}
                      carpetColor={editor.carpetColor}
                      carpetAccentColor={editor.carpetAccentColor}
                      onCarpetVariantChange={editor.handleCarpetVariantChange}
                      onCarpetColorChange={editor.handleCarpetColorChange}
                      onCarpetAccentColorChange={editor.handleCarpetAccentColorChange}
                      areas={officeState.getLayout().areas ?? []}
                      selectedAreaLabel={editor.selectedAreaLabel}
                      workspaceFolders={areaFolders}
                      areasAvailable={areasAvailable}
                      areaMappings={areaMappings}
                      onSelectArea={editor.handleSelectArea}
                      onAddArea={editor.handleAddArea}
                      onRemoveArea={editor.handleRemoveArea}
                      onRenameArea={editor.handleRenameArea}
                      onAreaColorChange={editor.handleAreaColorChange}
                      onAreaMappingChange={handleAreaMappingChange}
                    />
                  );
                })()}

              <ToolOverlay
                officeState={officeState}
                agents={agents}
                agentTools={agentTools}
                agentStatuses={agentStatuses}
                subagentTools={subagentTools}
                subagentCharacters={subagentCharacters}
                containerRef={containerRef}
                zoom={editor.zoom}
                panRef={editor.panRef}
                onCloseAgent={handleCloseAgent}
                alwaysShowOverlay={alwaysShowOverlay}
              />
              {officeSelection !== null && officeState.characters.get(officeSelection) && (
                <OfficeAgentDetail
                  id={officeSelection}
                  character={officeState.characters.get(officeSelection)!}
                  info={agentInfo[officeSelection]}
                  status={agentStatuses[officeSelection]}
                  activity={getActivityText(
                    officeSelection,
                    agentTools,
                    officeState.characters.get(officeSelection)?.isActive ?? false,
                    officeState.characters.get(officeSelection)?.bubbleType ?? null,
                    officeState.characters.get(officeSelection)?.waitingAwaitingInput ?? false,
                    agentStatuses[officeSelection],
                  )}
                  onClose={() => {
                    officeState.selectedAgentId = null;
                    setOfficeSelection(null);
                  }}
                  onFocus={() => handleOfficeDoubleClick(officeSelection)}
                />
              )}
            </>
          ) : (
            <DebugView
              agents={agents}
              selectedAgent={selectedAgent}
              agentTools={agentTools}
              agentStatuses={agentStatuses}
              subagentTools={subagentTools}
              officeState={officeState}
              onSelectAgent={handleSelectAgent}
            />
          )}
        </>
      )}

      {/* Hooks first-run tooltip */}
      {!hooksInfoShown && !hooksTooltipDismissed && (
        <Tooltip
          title="实时检测已开启"
          position="top-right"
          compact
          onDismiss={() => {
            setHooksTooltipDismissed(true);
            transport.send({ type: 'setHooksInfoShown' });
          }}
        >
          <span className="text-sm text-text leading-none">
            Agent 现在会实时响应。{' '}
            <span
              className="text-accent cursor-pointer underline"
              onClick={() => {
                setIsHooksInfoOpen(true);
                setHooksTooltipDismissed(true);
                transport.send({ type: 'setHooksInfoShown' });
              }}
            >
              查看详情
            </span>
          </span>
        </Tooltip>
      )}

      {/* Hooks info modal */}
      <Modal
        isOpen={isHooksInfoOpen}
        onClose={() => setIsHooksInfoOpen(false)}
        title="实时检测已开启"
        zIndex={52}
      >
        <div className="text-base text-text px-10" style={{ lineHeight: 1.4 }}>
          <p className="mb-8">Claude Fleet 现在会实时响应 Agent 状态：</p>
          <ul className="mb-8 pl-18 list-disc m-0">
            <li className="text-sm mb-2">权限请求会立即出现</li>
            <li className="text-sm mb-2">任务完成会立即被检测</li>
            <li className="text-sm mb-2">声音通知会即时播放</li>
          </ul>
          <p className="mb-12 text-text-muted">
            该功能通过 Claude Code Hooks 工作：它会在会话发生事件时通知 Claude Fleet。
          </p>
          <div className="text-center">
            <button
              onClick={() => setIsHooksInfoOpen(false)}
              className="py-4 px-20 text-lg bg-accent text-white border-2 border-accent rounded-none cursor-pointer shadow-pixel"
            >
              知道了
            </button>
          </div>
          <p className="mt-8 text-xs text-text-muted text-center">
            如需关闭，请前往“设置” {'>'} “实时检测”
          </p>
        </div>
      </Modal>

      {scene === 'pixel-office' ? (
        <BottomToolbar
          isEditMode={editor.isEditMode}
          onOpenClaude={editor.handleOpenClaude}
          onToggleEditMode={editor.handleToggleEditMode}
          isSettingsOpen={isSettingsOpen}
          onToggleSettings={() => setIsSettingsOpen((v) => !v)}
          workspaceFolders={workspaceFolders}
        />
      ) : null}

      {scene === 'pixel-office' ? (
        <VersionIndicator
          currentVersion={extensionVersion}
          lastSeenVersion={lastSeenVersion}
          onDismiss={handleWhatsNewDismiss}
          onOpenChangelog={handleOpenChangelog}
        />
      ) : null}

      <ConnectionIndicator />

      <ChangelogModal
        isOpen={isChangelogOpen}
        onClose={() => setIsChangelogOpen(false)}
        currentVersion={extensionVersion}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        scene={scene}
        defaultScene={defaultScene}
        onSceneChange={handleSceneChange}
        onDefaultSceneChange={handleDefaultSceneChange}
        isDebugMode={isDebugMode}
        onToggleDebugMode={handleToggleDebugMode}
        alwaysShowOverlay={alwaysShowOverlay}
        onToggleAlwaysShowOverlay={handleToggleAlwaysShowOverlay}
        ghostHeadlessAgents={ghostHeadlessAgents}
        onToggleGhostHeadlessAgents={handleToggleGhostHeadlessAgents}
        externalAssetDirectories={externalAssetDirectories}
        watchAllSessions={watchAllSessions}
        onToggleWatchAllSessions={() => {
          const newVal = !watchAllSessions;
          setWatchAllSessions(newVal);
          transport.send({ type: 'setWatchAllSessions', enabled: newVal });
        }}
        hooksEnabled={hooksEnabled}
        onToggleHooksEnabled={() => {
          const newVal = !hooksEnabled;
          setHooksEnabled(newVal);
          transport.send({ type: 'setHooksEnabled', enabled: newVal });
        }}
        showAreas={showAreas}
        onToggleShowAreas={onToggleShowAreas}
        showAreasAvailable={areasAvailable}
        onExportLayout={handleExportLayout}
        onImportLayout={handleImportLayout}
      />

      {showMigrationNotice && (
        <MigrationNotice onDismiss={() => setMigrationNoticeDismissed(true)} />
      )}
    </div>
  );
}

export default App;
