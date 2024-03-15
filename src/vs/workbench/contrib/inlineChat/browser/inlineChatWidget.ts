/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension, getActiveElement, getTotalHeight, h, reset, trackFocus } from 'vs/base/browser/dom';
import { renderFormattedText } from 'vs/base/browser/formattedTextRenderer';
import { renderLabelWithIcons } from 'vs/base/browser/ui/iconLabel/iconLabels';
import { ProgressBar } from 'vs/base/browser/ui/progressbar/progressbar';
import { Emitter, Event, MicrotaskEmitter } from 'vs/base/common/event';
import { IMarkdownString, MarkdownString } from 'vs/base/common/htmlContent';
import { Lazy } from 'vs/base/common/lazy';
import { DisposableStore, IReference, MutableDisposable } from 'vs/base/common/lifecycle';
import { ISettableObservable, constObservable, derived, observableValue } from 'vs/base/common/observable';
import 'vs/css!./media/inlineChat';
import { ICodeEditor, IDiffEditorConstructionOptions } from 'vs/editor/browser/editorBrowser';
import { AccessibleDiffViewer, IAccessibleDiffViewerModel } from 'vs/editor/browser/widget/diffEditor/components/accessibleDiffViewer';
import { EmbeddedDiffEditorWidget } from 'vs/editor/browser/widget/diffEditor/embeddedDiffEditorWidget';
import { EmbeddedCodeEditorWidget } from 'vs/editor/browser/widget/codeEditor/embeddedCodeEditorWidget';
import { EditorOption, IComputedEditorOptions } from 'vs/editor/common/config/editorOptions';
import { LineRange } from 'vs/editor/common/core/lineRange';
import { Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { DetailedLineRangeMapping, RangeMapping } from 'vs/editor/common/diff/rangeMapping';
import { ICodeEditorViewState, ScrollType } from 'vs/editor/common/editorCommon';
import { ITextModel } from 'vs/editor/common/model';
import { IResolvedTextEditorModel, ITextModelService } from 'vs/editor/common/services/resolverService';
import { localize } from 'vs/nls';
import { IAccessibilityService } from 'vs/platform/accessibility/common/accessibility';
import { IWorkbenchButtonBarOptions, MenuWorkbenchButtonBar } from 'vs/platform/actions/browser/buttonbar';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from 'vs/platform/actions/browser/toolbar';
import { MenuId } from 'vs/platform/actions/common/actions';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { FileKind } from 'vs/platform/files/common/files';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { asCssVariable, asCssVariableName, editorBackground, editorForeground, inputBackground } from 'vs/platform/theme/common/colorRegistry';
import { ResourceLabel } from 'vs/workbench/browser/labels';
import { AccessibilityVerbositySettingId } from 'vs/workbench/contrib/accessibility/browser/accessibilityConfiguration';
import { IAccessibleViewService } from 'vs/workbench/contrib/accessibility/browser/accessibleView';
import { AccessibilityCommandId } from 'vs/workbench/contrib/accessibility/common/accessibilityCommands';
import { ChatFollowups } from 'vs/workbench/contrib/chat/browser/chatFollowups';
import { ChatModel, IChatModel } from 'vs/workbench/contrib/chat/common/chatModel';
import { isResponseVM, isWelcomeVM } from 'vs/workbench/contrib/chat/common/chatViewModel';
import { HunkData, HunkInformation, Session } from 'vs/workbench/contrib/inlineChat/browser/inlineChatSession';
import { asRange, invertLineRange } from 'vs/workbench/contrib/inlineChat/browser/utils';
import { CTX_INLINE_CHAT_RESPONSE_FOCUSED, IInlineChatFollowup, IInlineChatSlashCommand, MENU_INLINE_CHAT_INPUT, inlineChatBackground } from 'vs/workbench/contrib/inlineChat/common/inlineChat';
import { IUntitledTextEditorModel } from 'vs/workbench/services/untitled/common/untitledTextEditorModel';
import { inputEditorOptions, codeEditorWidgetOptions, defaultAriaLabel } from './inlineChatInputWidget';
import { ChatWidget } from 'vs/workbench/contrib/chat/browser/chatWidget';
import { chatRequestBackground } from 'vs/workbench/contrib/chat/common/chatColors';
import { Selection } from 'vs/editor/common/core/selection';
import { ChatAgentLocation } from 'vs/workbench/contrib/chat/common/chatAgents';


const _previewEditorEditorOptions: IDiffEditorConstructionOptions = {
	scrollbar: { useShadows: false, alwaysConsumeMouseWheel: false, ignoreHorizontalScrollbarInContentHeight: true, },
	renderMarginRevertIcon: false,
	diffCodeLens: false,
	scrollBeyondLastLine: false,
	stickyScroll: { enabled: false },
	originalAriaLabel: localize('original', 'Original'),
	modifiedAriaLabel: localize('modified', 'Modified'),
	diffAlgorithm: 'advanced',
	readOnly: true,
	isInEmbeddedEditor: true
};

export interface InlineChatWidgetViewState {
	editorViewState: ICodeEditorViewState;
	input: string;
	placeholder: string;
}

export interface IInlineChatWidgetConstructionOptions {
	/**
	 * The telemetry source for all commands of this widget
	 */
	telemetrySource: string;
	/**
	 * The menu that is inside the input editor, use for send, dictation
	 */
	inputMenuId: MenuId;
	/**
	 * The menu that next to the input editor, use for close, config etc
	 */
	widgetMenuId: MenuId;
	/**
	 * The menu that rendered as button bar, use for accept, discard etc
	 */
	statusMenuId: MenuId | { menu: MenuId; options: IWorkbenchButtonBarOptions };
	/**
	 * The men that rendered in the lower right corner, use for feedback
	 */
	feedbackMenuId: MenuId;
}

export interface IInlineChatMessage {
	message: IMarkdownString;
	requestId: string;
	providerId: string;
}

export interface IInlineChatMessageAppender {
	appendContent(fragment: string): void;
	cancel(): void;
	complete(): void;
}

export class InlineChatWidget {

	protected readonly _elements = h(
		'div.inline-chat@root',
		[
			h('div.detectedIntent.hidden@detectedIntent'),
			h('div.previewDiff.hidden@previewDiff'),
			h('div.previewCreateTitle.show-file-icons.hidden@previewCreateTitle'),
			h('div.previewCreate.hidden@previewCreate'),
			h('div.chat-widget@chatWidget'),
			h('div.progress@progress'),
			h('div.followUps.hidden@followUps'),
			h('div.accessibleViewer@accessibleViewer'),
			h('div.status@status', [
				h('div.label.info.hidden@infoLabel'),
				h('div.actions.hidden@statusToolbar'),
				h('div.label.status.hidden@statusLabel'),
				h('div.actions.hidden@feedbackToolbar'),
			]),
		]
	);

	protected readonly _store = new DisposableStore();

	private readonly _ctxResponseFocused: IContextKey<boolean>;

	private readonly _progressBar: ProgressBar;

	private readonly _chatWidget: ChatWidget;

	// protected readonly _onDidChangeHeight = this._store.add(new MicrotaskEmitter<void>());
	protected readonly _onDidChangeHeight = this._store.add(new Emitter<void>());
	readonly onDidChangeHeight: Event<void> = Event.filter(this._onDidChangeHeight.event, _ => !this._isLayouting);

	private readonly _onDidChangeLayout = this._store.add(new MicrotaskEmitter<void>());
	private readonly _onDidChangeInput = this._store.add(new Emitter<this>());
	readonly onDidChangeInput: Event<this> = this._onDidChangeInput.event;

	private readonly _onRequestWithoutIntentDetection = this._store.add(new Emitter<void>());
	readonly onRequestWithoutIntentDetection: Event<void> = this._onRequestWithoutIntentDetection.event;

	private _lastDim: Dimension | undefined;
	private _isLayouting: boolean = false;


	private _followUpDisposables = this._store.add(new DisposableStore());
	private _slashCommandUsedDisposables = this._store.add(new DisposableStore());

	private _chatMessage: MarkdownString | undefined;

	constructor(
		location: ChatAgentLocation,
		options: IInlineChatWidgetConstructionOptions,
		@IInstantiationService protected readonly _instantiationService: IInstantiationService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@IAccessibilityService private readonly _accessibilityService: IAccessibilityService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IAccessibleViewService private readonly _accessibleViewService: IAccessibleViewService,
		@ITextModelService protected readonly _textModelResolverService: ITextModelService,
	) {
		// Share hover delegates between toolbars to support instant hover between both
		// TODO@jrieken move into chat widget
		// const hoverDelegate = this._store.add(createInstantHoverDelegate());

		this._store.add(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AccessibilityVerbositySettingId.InlineChat)) {
				this._updateAriaLabel();
			}
		}));

		// context keys
		this._ctxResponseFocused = CTX_INLINE_CHAT_RESPONSE_FOCUSED.bindTo(this._contextKeyService);
		const tracker = this._store.add(trackFocus(this.domNode));
		this._store.add(tracker.onDidBlur(() => this._ctxResponseFocused.set(false)));
		this._store.add(tracker.onDidFocus(() => this._ctxResponseFocused.set(true)));

		// toolbars
		this._progressBar = new ProgressBar(this._elements.progress);
		this._store.add(this._progressBar);

		this._chatWidget = _instantiationService.createInstance(
			ChatWidget,
			location,
			{ resource: true },
			{
				renderStyle: 'compact',
				renderInputOnTop: false,
				supportsFileReferences: true,
				menus: { executeToolbar: MENU_INLINE_CHAT_INPUT, inputSideToolbar: undefined, telemetrySource: options.telemetrySource },
				filter: item => {
					if (isWelcomeVM(item)) {
						return false;
					}
					return true;
				},
			},
			{
				listForeground: editorForeground,
				listBackground: inlineChatBackground,
				inputEditorBackground: inputBackground,
				resultEditorBackground: editorBackground
			}
		);
		this._chatWidget.render(this._elements.chatWidget);
		this._elements.chatWidget.style.setProperty(asCssVariableName(chatRequestBackground), asCssVariable(inlineChatBackground));


		this._chatWidget.setVisible(true);
		this._store.add(this._chatWidget);

		const statusMenuId = options.statusMenuId instanceof MenuId ? options.statusMenuId : options.statusMenuId.menu;
		const statusMenuOptions = options.statusMenuId instanceof MenuId ? undefined : options.statusMenuId.options;

		const statusButtonBar = this._instantiationService.createInstance(MenuWorkbenchButtonBar, this._elements.statusToolbar, statusMenuId, statusMenuOptions);
		this._store.add(statusButtonBar.onDidChange(() => this._onDidChangeHeight.fire()));
		this._store.add(statusButtonBar);


		const workbenchToolbarOptions = {
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			toolbarOptions: {
				primaryGroup: () => true,
				useSeparatorsInPrimaryActions: true
			}
		};

		const feedbackToolbar = this._instantiationService.createInstance(MenuWorkbenchToolBar, this._elements.feedbackToolbar, options.feedbackMenuId, { ...workbenchToolbarOptions, hiddenItemStrategy: HiddenItemStrategy.Ignore });
		this._store.add(feedbackToolbar.onDidChangeMenuItems(() => this._onDidChangeHeight.fire()));
		this._store.add(feedbackToolbar);


		this._elements.followUps.tabIndex = 0;
		this._elements.followUps.ariaLabel = this._accessibleViewService.getOpenAriaHint(AccessibilityVerbositySettingId.InlineChat);

		this._elements.statusLabel.tabIndex = 0;

		this._store.add(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AccessibilityVerbositySettingId.InlineChat)) {
				// TODO@jrieken	FIX THIS
				// this._chatWidget.ariaLabel = this._accessibleViewService.getOpenAriaHint(AccessibilityVerbositySettingId.InlineChat);
				this._elements.followUps.ariaLabel = this._accessibleViewService.getOpenAriaHint(AccessibilityVerbositySettingId.InlineChat);
			}
		}));
	}

	private _updateAriaLabel(): void {
		if (!this._accessibilityService.isScreenReaderOptimized()) {
			return;
		}
		let label = defaultAriaLabel;
		if (this._configurationService.getValue<boolean>(AccessibilityVerbositySettingId.InlineChat)) {
			const kbLabel = this._keybindingService.lookupKeybinding(AccessibilityCommandId.OpenAccessibilityHelp)?.getLabel();
			label = kbLabel ? localize('inlineChat.accessibilityHelp', "Inline Chat Input, Use {0} for Inline Chat Accessibility Help.", kbLabel) : localize('inlineChat.accessibilityHelpNoKb', "Inline Chat Input, Run the Inline Chat Accessibility Help command for more information.");
		}
		inputEditorOptions.ariaLabel = label;
		this._chatWidget.inputEditor.updateOptions({ ariaLabel: label });
	}

	dispose(): void {
		this._store.dispose();
	}

	get domNode(): HTMLElement {
		return this._elements.root;
	}

	get chatWidget(): ChatWidget {
		return this._chatWidget;
	}

	saveState() {
		this._chatWidget.saveState();
	}

	layout(widgetDim: Dimension) {
		this._isLayouting = true;
		try {
			if (!this._lastDim || !Dimension.equals(this._lastDim, widgetDim)) {
				this._lastDim = widgetDim;
				this._doLayout(widgetDim);
			}
		} finally {
			this._onDidChangeLayout.fire();
			this._isLayouting = false;
		}
	}

	protected _doLayout(dimension: Dimension): void {
		console.log('InlineChat#layout', dimension);
		const extraHeight = this._getExtraHeight();
		const progressHeight = getTotalHeight(this._elements.progress);
		const detectedIntentHeight = getTotalHeight(this._elements.detectedIntent);
		const followUpsHeight = getTotalHeight(this._elements.followUps);
		const statusHeight = getTotalHeight(this._elements.status);

		this._elements.root.style.height = `${dimension.height - extraHeight}px`;
		this._elements.root.style.width = `${dimension.width}px`;
		this._elements.progress.style.width = `${dimension.width}px`;

		this._chatWidget.layout(
			dimension.height - progressHeight - detectedIntentHeight - followUpsHeight - statusHeight - extraHeight,
			dimension.width
		);
	}

	getContentHeight(): number {

		const detectedIntentHeight = getTotalHeight(this._elements.detectedIntent);
		const followUpsHeight = getTotalHeight(this._elements.followUps);
		const chatWidgetHeight = this._chatWidget.contentHeight;
		const progressHeight = getTotalHeight(this._elements.progress);
		const statusHeight = getTotalHeight(this._elements.status);
		const extraHeight = this._getExtraHeight();

		const result = progressHeight + chatWidgetHeight + detectedIntentHeight + followUpsHeight + statusHeight + extraHeight;

		console.log('InlineChat#contentHeight', result);
		return result;
	}

	private _getExtraHeight(): number {
		return 12 /* padding */ + 2 /*border*/ + 12 /*shadow*/;
	}

	updateProgress(show: boolean) {
		if (show) {
			this._progressBar.show();
			this._progressBar.infinite();
		} else {
			this._progressBar.stop();
			this._progressBar.hide();
		}
	}

	get value(): string {
		return this._chatWidget.getInput();
	}

	set value(value: string) {
		this._chatWidget.setInput(value);
	}

	selectAll(includeSlashCommand: boolean = true) {
		// TODO@jrieken includeSlashCommand
		this._chatWidget.inputEditor.setSelection(new Selection(1, 1, Number.MAX_SAFE_INTEGER, 1));
	}

	set placeholder(value: string) {
		this._chatWidget.setInputPlaceholder(value);
	}

	updateToolbar(show: boolean) {
		this._elements.statusToolbar.classList.toggle('hidden', !show);
		this._elements.feedbackToolbar.classList.toggle('hidden', !show);
		this._elements.status.classList.toggle('actions', show);
		this._elements.infoLabel.classList.toggle('hidden', show);
		this._onDidChangeHeight.fire();
	}

	getCodeBlockInfo(codeBlockIndex: number): Promise<IReference<IResolvedTextEditorModel>> | undefined {
		const { viewModel } = this._chatWidget;
		if (!viewModel) {
			return undefined;
		}
		for (const item of viewModel.getItems()) {
			if (isResponseVM(item)) {
				return viewModel.codeBlockModelCollection.get(viewModel.sessionId, item, codeBlockIndex);
			}
		}
		return undefined;
	}

	get responseContent(): string | undefined {
		return this._chatMessage?.value;
	}

	setChatModel(chatModel: IChatModel) {
		this._chatWidget.setModel(chatModel, { inputValue: undefined });
	}


	updateChatMessage(message: IInlineChatMessage, isIncomplete: true): IInlineChatMessageAppender;
	updateChatMessage(message: IInlineChatMessage | undefined): void;
	updateChatMessage(message: IInlineChatMessage | undefined, isIncomplete?: boolean, isCodeBlockEditable?: boolean): IInlineChatMessageAppender | undefined;
	updateChatMessage(message: IInlineChatMessage | undefined, isIncomplete?: boolean, isCodeBlockEditable?: boolean): IInlineChatMessageAppender | undefined {
		// TODO@jrieken EDITABLE CODE BLOCKS
		if (!this._chatWidget.viewModel) {
			return;
		}
		if (!message?.message.value) {
			return;
		}
		const model = this._chatWidget.viewModel.model as ChatModel;
		const chatRequest = model.addRequest({ parts: [], text: '' }, { variables: [] });
		model.acceptResponseProgress(chatRequest, {
			kind: 'markdownContent',
			content: message.message
		});

		if (!isIncomplete) {
			return;
		}
		return {
			cancel: () => model.cancelRequest(chatRequest),
			complete: () => model.completeResponse(chatRequest),
			appendContent: (fragment: string) => {
				model.acceptResponseProgress(chatRequest, {
					kind: 'markdownContent',
					content: new MarkdownString(fragment)
				});
			}
		};
	}

	updateFollowUps(items: IInlineChatFollowup[], onFollowup: (followup: IInlineChatFollowup) => void): void;
	updateFollowUps(items: undefined): void;
	updateFollowUps(items: IInlineChatFollowup[] | undefined, onFollowup?: ((followup: IInlineChatFollowup) => void)) {
		this._followUpDisposables.clear();
		this._elements.followUps.classList.toggle('hidden', !items || items.length === 0);
		reset(this._elements.followUps);
		if (items && items.length > 0 && onFollowup) {
			this._followUpDisposables.add(
				this._instantiationService.createInstance(ChatFollowups, this._elements.followUps, items, undefined, onFollowup));
		}
		this._onDidChangeHeight.fire();
	}

	private _currentSlashCommands: IInlineChatSlashCommand[] = [];

	updateSlashCommands(commands: IInlineChatSlashCommand[]) {
		this._currentSlashCommands = commands;
		// this._inputWidget.updateSlashCommands(commands);
		// TODO@jrieken
	}

	updateSlashCommandUsed(command: string): void {
		const details = this._currentSlashCommands.find(candidate => candidate.command === command);
		if (!details) {
			return;
		}

		this._elements.detectedIntent.classList.toggle('hidden', false);

		this._slashCommandUsedDisposables.clear();

		const label = localize('slashCommandUsed', "Using {0} to generate response ([[re-run without]])", `\`\`/${details.command}\`\``);
		const usingSlashCommandText = renderFormattedText(label, {
			inline: true,
			renderCodeSegments: true,
			className: 'slash-command-pill',
			actionHandler: {
				callback: (content) => {
					if (content !== '0') {
						return;
					}
					this._elements.detectedIntent.classList.toggle('hidden', true);
					this._onRequestWithoutIntentDetection.fire();
				},
				disposables: this._slashCommandUsedDisposables,
			}
		});

		reset(this._elements.detectedIntent, usingSlashCommandText);
		this._onDidChangeHeight.fire();
	}

	updateInfo(message: string): void {
		this._elements.infoLabel.classList.toggle('hidden', !message);
		const renderedMessage = renderLabelWithIcons(message);
		reset(this._elements.infoLabel, ...renderedMessage);
		this._onDidChangeHeight.fire();
	}

	updateStatus(message: string, ops: { classes?: string[]; resetAfter?: number; keepMessage?: boolean } = {}) {
		const isTempMessage = typeof ops.resetAfter === 'number';
		if (isTempMessage && !this._elements.statusLabel.dataset['state']) {
			const statusLabel = this._elements.statusLabel.innerText;
			const classes = Array.from(this._elements.statusLabel.classList.values());
			setTimeout(() => {
				this.updateStatus(statusLabel, { classes, keepMessage: true });
			}, ops.resetAfter);
		}
		reset(this._elements.statusLabel, message);
		this._elements.statusLabel.className = `label status ${(ops.classes ?? []).join(' ')}`;
		this._elements.statusLabel.classList.toggle('hidden', !message);
		if (isTempMessage) {
			this._elements.statusLabel.dataset['state'] = 'temp';
		} else {
			delete this._elements.statusLabel.dataset['state'];
		}
		this._onDidChangeHeight.fire();
	}

	reset() {
		this._chatWidget.saveState();
		// this._chatWidget.setInput(undefined);
		this.updateChatMessage(undefined);
		this.updateFollowUps(undefined);

		reset(this._elements.statusLabel);
		this._elements.detectedIntent.classList.toggle('hidden', true);
		this._elements.statusLabel.classList.toggle('hidden', true);
		this._elements.statusToolbar.classList.add('hidden');
		this._elements.feedbackToolbar.classList.add('hidden');
		this.updateInfo('');

		this._elements.accessibleViewer.classList.toggle('hidden', true);
		this._onDidChangeHeight.fire();
	}

	focus() {
		this._chatWidget.focusInput();
	}

	hasFocus() {
		return this.domNode.contains(getActiveElement());
	}

}

export class EditorBasedInlineChatWidget extends InlineChatWidget {

	private readonly _accessibleViewer = this._store.add(new MutableDisposable<HunkAccessibleDiffViewer>());

	private readonly _previewDiffEditor: Lazy<EmbeddedDiffEditorWidget>;
	private readonly _previewDiffModel = this._store.add(new MutableDisposable());

	private readonly _previewCreateTitle: ResourceLabel;
	private readonly _previewCreateEditor: Lazy<ICodeEditor>;
	private readonly _previewCreateDispoable = this._store.add(new MutableDisposable());

	constructor(
		private readonly _parentEditor: ICodeEditor,
		options: IInlineChatWidgetConstructionOptions,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IAccessibilityService accessibilityService: IAccessibilityService,
		@IConfigurationService configurationService: IConfigurationService,
		@IAccessibleViewService accessibleViewService: IAccessibleViewService,
		@ITextModelService textModelResolverService: ITextModelService,
	) {
		super(ChatAgentLocation.Editor, options, instantiationService, contextKeyService, keybindingService, accessibilityService, configurationService, accessibleViewService, textModelResolverService);

		// preview editors
		this._previewDiffEditor = new Lazy(() => this._store.add(instantiationService.createInstance(EmbeddedDiffEditorWidget, this._elements.previewDiff, {
			useInlineViewWhenSpaceIsLimited: false,
			..._previewEditorEditorOptions,
			onlyShowAccessibleDiffViewer: accessibilityService.isScreenReaderOptimized(),
		}, { modifiedEditor: codeEditorWidgetOptions, originalEditor: codeEditorWidgetOptions }, _parentEditor)));

		this._previewCreateTitle = this._store.add(instantiationService.createInstance(ResourceLabel, this._elements.previewCreateTitle, { supportIcons: true }));
		this._previewCreateEditor = new Lazy(() => this._store.add(instantiationService.createInstance(EmbeddedCodeEditorWidget, this._elements.previewCreate, _previewEditorEditorOptions, codeEditorWidgetOptions, _parentEditor)));
	}

	// --- layout

	override getContentHeight(): number {
		const result = super.getContentHeight();
		const previewDiffHeight = this._previewDiffEditor.hasValue && this._previewDiffEditor.value.getModel() ? 12 + Math.min(300, Math.max(0, this._previewDiffEditor.value.getContentHeight())) : 0;
		const previewCreateTitleHeight = getTotalHeight(this._elements.previewCreateTitle);
		const previewCreateHeight = this._previewCreateEditor.hasValue && this._previewCreateEditor.value.getModel() ? 18 + Math.min(300, Math.max(0, this._previewCreateEditor.value.getContentHeight())) : 0;
		const accessibleViewHeight = this._accessibleViewer.value?.height ?? 0;
		return result + previewDiffHeight + previewCreateTitleHeight + previewCreateHeight + accessibleViewHeight;
	}

	protected override _doLayout(widgetDimension: Dimension): void {
		super._doLayout(widgetDimension);

		if (this._accessibleViewer.value) {
			this._accessibleViewer.value.width = widgetDimension.width - 12;
		}

		if (this._previewDiffEditor.hasValue) {
			const previewDiffDim = new Dimension(widgetDimension.width - 12, Math.min(300, Math.max(0, this._previewDiffEditor.value.getContentHeight())));
			this._elements.previewDiff.style.width = `${previewDiffDim.width}px`;
			this._elements.previewDiff.style.height = `${previewDiffDim.height}px`;
			this._previewDiffEditor.value.layout(previewDiffDim);
		}

		if (this._previewCreateEditor.hasValue) {
			const previewCreateDim = new Dimension(widgetDimension.width, Math.min(300, Math.max(0, this._previewCreateEditor.value.getContentHeight())));
			this._previewCreateEditor.value.layout(previewCreateDim);
			this._elements.previewCreate.style.height = `${previewCreateDim.height}px`;
		}
	}

	override reset() {
		this.hideCreatePreview();
		this.hideEditsPreview();
		this._accessibleViewer.clear();
		super.reset();
	}

	// --- accessible viewer

	showAccessibleHunk(session: Session, hunkData: HunkInformation): void {

		this._elements.accessibleViewer.classList.remove('hidden');
		this._accessibleViewer.clear();

		this._accessibleViewer.value = this._instantiationService.createInstance(HunkAccessibleDiffViewer,
			this._elements.accessibleViewer,
			session,
			hunkData,
			new AccessibleHunk(this._parentEditor, session, hunkData)
		);

		this._onDidChangeHeight.fire();

	}

	// --- preview

	showEditsPreview(hunks: HunkData, textModel0: ITextModel, textModelN: ITextModel) {

		if (hunks.size === 0) {
			this.hideEditsPreview();
			return;
		}

		this._elements.previewDiff.classList.remove('hidden');

		this._previewDiffEditor.value.setModel({ original: textModel0, modified: textModelN });

		// joined ranges
		let originalLineRange: LineRange | undefined;
		let modifiedLineRange: LineRange | undefined;
		for (const item of hunks.getInfo()) {
			const [first0] = item.getRanges0();
			const [firstN] = item.getRangesN();

			originalLineRange = !originalLineRange ? LineRange.fromRangeInclusive(first0) : originalLineRange.join(LineRange.fromRangeInclusive(first0));
			modifiedLineRange = !modifiedLineRange ? LineRange.fromRangeInclusive(firstN) : modifiedLineRange.join(LineRange.fromRangeInclusive(firstN));
		}

		if (!originalLineRange || !modifiedLineRange) {
			this.hideEditsPreview();
			return;
		}

		const hiddenOriginal = invertLineRange(originalLineRange, textModel0);
		const hiddenModified = invertLineRange(modifiedLineRange, textModelN);
		this._previewDiffEditor.value.getOriginalEditor().setHiddenAreas(hiddenOriginal.map(lr => asRange(lr, textModel0)), 'diff-hidden');
		this._previewDiffEditor.value.getModifiedEditor().setHiddenAreas(hiddenModified.map(lr => asRange(lr, textModelN)), 'diff-hidden');
		this._previewDiffEditor.value.revealLine(modifiedLineRange.startLineNumber, ScrollType.Immediate);

		this._onDidChangeHeight.fire();
	}

	hideEditsPreview() {
		this._elements.previewDiff.classList.add('hidden');
		if (this._previewDiffEditor.hasValue) {
			this._previewDiffEditor.value.setModel(null);
		}
		this._previewDiffModel.clear();
		this._onDidChangeHeight.fire();
	}

	async showCreatePreview(model: IUntitledTextEditorModel): Promise<void> {
		this._elements.previewCreateTitle.classList.remove('hidden');
		this._elements.previewCreate.classList.remove('hidden');

		const ref = await this._textModelResolverService.createModelReference(model.resource);
		this._previewCreateDispoable.value = ref;
		this._previewCreateTitle.element.setFile(model.resource, { fileKind: FileKind.FILE });

		this._previewCreateEditor.value.setModel(ref.object.textEditorModel);
		this._onDidChangeHeight.fire();
	}

	hideCreatePreview() {
		this._elements.previewCreateTitle.classList.add('hidden');
		this._elements.previewCreate.classList.add('hidden');
		this._previewCreateEditor.rawValue?.setModel(null);
		this._previewCreateDispoable.clear();
		this._previewCreateTitle.element.clear();
		this._onDidChangeHeight.fire();
	}

	showsAnyPreview() {
		return !this._elements.previewDiff.classList.contains('hidden') ||
			!this._elements.previewCreate.classList.contains('hidden');
	}
}

class HunkAccessibleDiffViewer extends AccessibleDiffViewer {

	readonly height: number;

	set width(value: number) {
		this._width2.set(value, undefined);
	}

	private readonly _width2: ISettableObservable<number>;

	constructor(
		parentNode: HTMLElement,
		session: Session,
		hunk: HunkInformation,
		models: IAccessibleDiffViewerModel,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		const width = observableValue('width', 0);
		const diff = observableValue('diff', HunkAccessibleDiffViewer._asMapping(hunk));
		const diffs = derived(r => [diff.read(r)]);
		const lines = Math.min(10, 8 + diff.get().changedLineCount);
		const height = models.getModifiedOptions().get(EditorOption.lineHeight) * lines;

		super(parentNode, constObservable(true), () => { }, constObservable(false), width, constObservable(height), diffs, models, instantiationService);

		this.height = height;
		this._width2 = width;

		this._store.add(session.textModelN.onDidChangeContent(() => {
			diff.set(HunkAccessibleDiffViewer._asMapping(hunk), undefined);
		}));
	}

	private static _asMapping(hunk: HunkInformation): DetailedLineRangeMapping {
		const ranges0 = hunk.getRanges0();
		const rangesN = hunk.getRangesN();
		const originalLineRange = LineRange.fromRangeInclusive(ranges0[0]);
		const modifiedLineRange = LineRange.fromRangeInclusive(rangesN[0]);
		const innerChanges: RangeMapping[] = [];
		for (let i = 1; i < ranges0.length; i++) {
			innerChanges.push(new RangeMapping(ranges0[i], rangesN[i]));
		}
		return new DetailedLineRangeMapping(originalLineRange, modifiedLineRange, innerChanges);
	}

}

class AccessibleHunk implements IAccessibleDiffViewerModel {

	constructor(
		private readonly _editor: ICodeEditor,
		private readonly _session: Session,
		private readonly _hunk: HunkInformation
	) { }

	getOriginalModel(): ITextModel {
		return this._session.textModel0;
	}
	getModifiedModel(): ITextModel {
		return this._session.textModelN;
	}
	getOriginalOptions(): IComputedEditorOptions {
		return this._editor.getOptions();
	}
	getModifiedOptions(): IComputedEditorOptions {
		return this._editor.getOptions();
	}
	originalReveal(range: Range): void {
		// throw new Error('Method not implemented.');
	}
	modifiedReveal(range?: Range | undefined): void {
		this._editor.revealRangeInCenterIfOutsideViewport(range || this._hunk.getRangesN()[0], ScrollType.Smooth);
	}
	modifiedSetSelection(range: Range): void {
		// this._editor.revealRangeInCenterIfOutsideViewport(range, ScrollType.Smooth);
		// this._editor.setSelection(range);
	}
	modifiedFocus(): void {
		this._editor.focus();
	}
	getModifiedPosition(): Position | undefined {
		return this._hunk.getRangesN()[0].getStartPosition();
	}
}
