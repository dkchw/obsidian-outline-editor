import { App, Plugin, PluginSettingTab, Setting, Modal, Notice, MarkdownView, requestUrl } from 'obsidian';

interface OutlineEditorSettings {
    apiKey: string;
    model: string;
    aiPrompt: string;
}

const DEFAULT_SETTINGS: OutlineEditorSettings = {
    apiKey: '',
    model: 'anthropic/claude-3.5-sonnet',
    aiPrompt: 'Please improve this document outline by making the headings clearer, more consistent, and better organized. Maintain the same general structure but improve wording and hierarchy where needed.'
}

interface HeadingInfo {
    level: number;
    text: string;
    line: number;
    originalLine: string;
    id: string; // Unique identifier for matching
}

export default class OutlineEditorPlugin extends Plugin {
    settings: OutlineEditorSettings;

    async onload() {
        await this.loadSettings();

        // Add ribbon icon
        this.addRibbonIcon('list-tree', 'Edit Outline', () => {
            this.openOutlineEditor();
        });

        // Add command
        this.addCommand({
            id: 'open-outline-editor',
            name: 'Edit Document Outline',
            callback: () => {
                this.openOutlineEditor();
            }
        });

        // Add settings tab
        this.addSettingTab(new OutlineEditorSettingTab(this.app, this));
    }

    openOutlineEditor() {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView) {
            new Notice('No active markdown file');
            return;
        }

        new OutlineEditorModal(this.app, activeView, this.settings).open();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

class OutlineEditorModal extends Modal {
    private view: MarkdownView;
    private settings: OutlineEditorSettings;
    private headings: HeadingInfo[] = [];
    private textArea: HTMLTextAreaElement;
    private aiButton: HTMLButtonElement;
    private isProcessing: boolean = false;

    constructor(app: App, view: MarkdownView, settings: OutlineEditorSettings) {
        super(app);
        this.view = view;
        this.settings = settings;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Edit Document Outline' });

        // Parse current file
        this.parseHeadings();

        // Create outline text with markers
        const outlineText = this.headings
            .map(h => `${h.id}|${'#'.repeat(h.level)} ${h.text}`)
            .join('\n');

        // Create editable text area
        const textAreaContainer = contentEl.createDiv({ cls: 'outline-editor-container' });
        this.textArea = textAreaContainer.createEl('textarea', {
            cls: 'outline-editor-textarea'
        });
        this.textArea.value = outlineText;
        this.textArea.rows = 20;

        // Instructions
        contentEl.createEl('p', { 
            text: 'Edit heading levels (#), text, or remove lines. Keep the ID markers (e.g., "H1|") for accurate matching.',
            cls: 'outline-editor-instructions'
        });

        // Buttons
        const buttonContainer = contentEl.createDiv({ cls: 'outline-editor-buttons' });
        
        // AI Button
        this.aiButton = buttonContainer.createEl('button', { text: '✨ AI Enhance' });
        this.aiButton.onclick = () => this.enhanceWithAI();
        
        if (!this.settings.apiKey) {
            this.aiButton.disabled = true;
            this.aiButton.title = 'Configure OpenRouter API key in settings';
        }

        const doneButton = buttonContainer.createEl('button', { text: 'Done' });
        doneButton.onclick = () => this.applyChanges();

        const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelButton.onclick = () => this.close();
    }

    parseHeadings() {
        const content = this.view.editor.getValue();
        const lines = content.split('\n');

        this.headings = [];
        let headingCounter = 0;
        lines.forEach((line, index) => {
            const match = line.match(/^(#{1,6})\s+(.+)$/);
            if (match) {
                headingCounter++;
                this.headings.push({
                    level: match[1].length,
                    text: match[2],
                    line: index,
                    originalLine: line,
                    id: `H${headingCounter}`
                });
            }
        });
    }

    async enhanceWithAI() {
        if (!this.settings.apiKey) {
            new Notice('Please configure OpenRouter API key in settings');
            return;
        }

        if (this.isProcessing) {
            return;
        }

        this.isProcessing = true;
        this.aiButton.disabled = true;
        this.aiButton.setText('⏳ Processing...');

        try {
            // Get current outline without IDs for AI
            const currentOutline = this.textArea.value
                .split('\n')
                .map(line => {
                    const match = line.match(/^H\d+\|(.+)$/);
                    return match ? match[1] : line;
                })
                .join('\n');

            const response = await requestUrl({
                url: 'https://openrouter.ai/api/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.settings.apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://obsidian.md',
                    'X-Title': 'Obsidian Outline Editor'
                },
                body: JSON.stringify({
                    model: this.settings.model,
                    messages: [
                        {
                            role: 'user',
                            content: `${this.settings.aiPrompt}\n\nCurrent outline:\n${currentOutline}\n\nPlease return ONLY the improved outline in the same markdown heading format (using # for headings). Do not include any explanations or additional text.`
                        }
                    ]
                })
            });

            const data = response.json;
            let enhancedOutline = data.choices[0].message.content.trim();

            // Remove markdown code blocks if present
            enhancedOutline = enhancedOutline.replace(/```markdown\n?/g, '').replace(/```\n?/g, '').trim();

            // Re-add IDs by matching with original headings
            const enhancedLines = enhancedOutline.split('\n').filter(l => l.trim());
            const originalLines = this.textArea.value.split('\n').filter(l => l.trim());
            
            const newOutlineWithIds = this.matchHeadingsWithIds(originalLines, enhancedLines);
            
            this.textArea.value = newOutlineWithIds.join('\n');
            new Notice('Outline enhanced with AI!');

        } catch (error) {
            console.error('AI enhancement error:', error);
            new Notice('Error: ' + error.message);
        } finally {
            this.isProcessing = false;
            this.aiButton.disabled = false;
            this.aiButton.setText('✨ AI Enhance');
        }
    }

    matchHeadingsWithIds(originalLines: string[], enhancedLines: string[]): string[] {
        const result: string[] = [];
        let originalIndex = 0;

        for (const enhancedLine of enhancedLines) {
            if (originalIndex < originalLines.length) {
                // Extract ID from original line
                const idMatch = originalLines[originalIndex].match(/^(H\d+)\|/);
                if (idMatch) {
                    result.push(`${idMatch[1]}|${enhancedLine}`);
                    originalIndex++;
                } else {
                    result.push(enhancedLine);
                }
            } else {
                // New heading added by AI
                result.push(`NEW|${enhancedLine}`);
            }
        }

        return result;
    }

    applyChanges() {
        const editedLines = this.textArea.value.split('\n').filter(line => line.trim());
        const content = this.view.editor.getValue();
        const lines = content.split('\n');

        // Parse edited outline
        const editedHeadings: { id: string; level: number; text: string }[] = [];
        for (const line of editedLines) {
            const match = line.match(/^(H\d+|NEW)\|\s*(#{1,6})\s+(.+)$/);
            if (match) {
                editedHeadings.push({
                    id: match[1],
                    level: match[2].length,
                    text: match[3].trim()
                });
            }
        }

        // Create mapping of ID to edited heading
        const editMap = new Map<string, { level: number; text: string }>();
        const deletedIds = new Set<string>();
        const newHeadings: { level: number; text: string }[] = [];

        // Track which original IDs are present in edited version
        const originalIds = new Set(this.headings.map(h => h.id));
        const editedIds = new Set(editedHeadings.map(h => h.id));

        for (const edited of editedHeadings) {
            if (edited.id === 'NEW') {
                newHeadings.push({ level: edited.level, text: edited.text });
            } else {
                editMap.set(edited.id, { level: edited.level, text: edited.text });
            }
        }

        // Find deleted headings
        for (const id of originalIds) {
            if (!editedIds.has(id)) {
                deletedIds.add(id);
            }
        }

        // Apply changes
        const linesToRemove: number[] = [];
        let changesMade = false;

        // Update or mark for deletion
        for (const heading of this.headings) {
            if (deletedIds.has(heading.id)) {
                linesToRemove.push(heading.line);
                changesMade = true;
            } else if (editMap.has(heading.id)) {
                const newHeading = editMap.get(heading.id)!;
                const newLine = '#'.repeat(newHeading.level) + ' ' + newHeading.text;
                if (lines[heading.line] !== newLine) {
                    lines[heading.line] = newLine;
                    changesMade = true;
                }
            }
        }

        // Remove deleted lines in reverse order
        linesToRemove.sort((a, b) => b - a);
        for (const lineIndex of linesToRemove) {
            lines.splice(lineIndex, 1);
        }

        // Add new headings at the end (or you could add them in position)
        if (newHeadings.length > 0) {
            for (const newHeading of newHeadings) {
                lines.push('#'.repeat(newHeading.level) + ' ' + newHeading.text);
            }
            changesMade = true;
        }

        if (changesMade) {
            this.view.editor.setValue(lines.join('\n'));
            new Notice(`Outline updated: ${editMap.size} modified, ${deletedIds.size} removed, ${newHeadings.length} added`);
        } else {
            new Notice('No changes detected');
        }

        this.close();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class OutlineEditorSettingTab extends PluginSettingTab {
    plugin: OutlineEditorPlugin;

    constructor(app: App, plugin: OutlineEditorPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();
        containerEl.createEl('h2', { text: 'Outline Editor Settings' });

        new Setting(containerEl)
            .setName('OpenRouter API Key')
            .setDesc('Enter your OpenRouter API key. Get one at https://openrouter.ai/keys')
            .addText(text => text
                .setPlaceholder('sk-or-v1-...')
                .setValue(this.plugin.settings.apiKey)
                .onChange(async (value) => {
                    this.plugin.settings.apiKey = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('AI Model')
            .setDesc('OpenRouter model to use')
            .addText(text => text
                .setPlaceholder('anthropic/claude-3.5-sonnet')
                .setValue(this.plugin.settings.model)
                .onChange(async (value) => {
                    this.plugin.settings.model = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('AI Prompt')
            .setDesc('Customize the prompt sent to the AI')
            .addTextArea(text => {
                text
                    .setPlaceholder('Enter your custom prompt...')
                    .setValue(this.plugin.settings.aiPrompt)
                    .onChange(async (value) => {
                        this.plugin.settings.aiPrompt = value;
                        await this.plugin.saveSettings();
                    });
                text.inputEl.rows = 6;
                text.inputEl.cols = 50;
            });

        containerEl.createEl('h3', { text: 'Available Models' });
        containerEl.createEl('p', { text: 'Popular models:' });
        const modelList = containerEl.createEl('ul');
        modelList.createEl('li', { text: 'anthropic/claude-3.5-sonnet (recommended)' });
        modelList.createEl('li', { text: 'anthropic/claude-3-opus' });
        modelList.createEl('li', { text: 'openai/gpt-4-turbo' });
        modelList.createEl('li', { text: 'openai/gpt-3.5-turbo' });
        containerEl.createEl('p').innerHTML = 'See all models at <a href="https://openrouter.ai/models">https://openrouter.ai/models</a>';
    }
}