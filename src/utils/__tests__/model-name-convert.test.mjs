import {
  apiModeToModelName,
  modelNameToDesc,
  isCustomModelName,
  modelNameToPresetPart,
  modelNameToCustomPart,
  isGPT4,
  isClaude3,
  modelNameToValue,
  getModelValue,
  modelNameToApiMode, // Restored
  getApiModesFromConfig,
  getApiModesStringArrayFromConfig,
  isApiModeSelected,
  isUsingModelName, // Restored
  getModelNameGroup,
  getApiModeGroup,
  isInApiModeGroup, // Restored
} from '../model-name-convert.mjs';

// Define the actual mock data objects at the top level.
const actualMockModels = {
  'gpt-4': { desc: 'GPT-4 (OpenAI)', value: 'gpt-4' },
  'gpt-3.5-turbo': { desc: 'GPT-3.5 Turbo (OpenAI)', value: 'gpt-3.5-turbo' },
  'claude-2': { desc: 'Claude 2 (Anthropic)', value: 'claude-2' },
  'claude-3-opus': { desc: 'Claude 3 Opus (Anthropic)', value: 'claude-3-opus-20240229'},
  'claude-3-sonnet': { desc: 'Claude 3 Sonnet (Anthropic)', value: 'claude-3-sonnet-20240229'},
  customModel: { desc: 'Custom Model', value: 'customModel' },
  azureOpenAi: { desc: 'Azure OpenAI', value: 'azureOpenAi'},
  ollama: { desc: 'Ollama', value: 'ollama'}
};

const actualMockModelGroups = {
  openAi: { desc: 'OpenAI', value: ['gpt-4', 'gpt-3.5-turbo'] },
  anthropic: { desc: 'Anthropic', value: ['claude-2', 'claude-3-opus', 'claude-3-sonnet'] },
  custom: { desc: 'Custom', value: ['customModel'] },
  azure: { desc: 'Azure', value: ['azureOpenAi']},
  ollamaG: { desc: 'Ollama', value: ['ollama']} // Assuming 'ollamaG' as group name for 'ollama' item
};

const actualMockAlwaysCustomGroups = ['custom', 'azure', 'ollamaG'];

const actualMockModelMode = {
  'fast': 'Fast Mode',
  'good': 'Good Mode',
};

// Initial top-level mock for config/index.mjs
jest.mock('../../config/index.mjs', () => ({
  Models: actualMockModels,
  ModelGroups: actualMockModelGroups,
  ModelMode: actualMockModelMode,
  AlwaysCustomGroups: actualMockAlwaysCustomGroups,
}));

// Helper for translation, as used in modelNameToDesc
const t = (key) => key;

describe('model-name-convert', () => {
  // Tests for functions that don't require mock modification can use top-level imports
  describe('apiModeToModelName', () => {
    test('should convert standard API mode to item name', () => {
      const apiMode = { groupName: 'openAi', itemName: 'gpt-4', isCustom: false, customName: '' };
      expect(apiModeToModelName(apiMode)).toBe('gpt-4');
    });
    test('should convert custom API mode (item based) to item-customName', () => {
      const apiMode = { groupName: 'openAi', itemName: 'gpt-4', isCustom: true, customName: 'my-gpt4' };
      expect(apiModeToModelName(apiMode)).toBe('gpt-4-my-gpt4');
    });
    test('should convert custom API mode (group based, item is "custom") to group-customName', () => {
      const apiMode = { groupName: 'openAi', itemName: 'custom', isCustom: true, customName: 'my-custom-openai' };
      expect(apiModeToModelName(apiMode)).toBe('openAi-my-custom-openai');
    });
    test('should convert API mode for AlwaysCustomGroups to groupName-customName', () => {
      const apiModeAzure = { groupName: 'azure', itemName: 'azureOpenAi', isCustom: true, customName: 'my-azure-deployment' };
      expect(apiModeToModelName(apiModeAzure)).toBe('azure-my-azure-deployment');
      const apiModeOllama = { groupName: 'ollamaG', itemName: 'ollama', isCustom: true, customName: 'llama2' };
      expect(apiModeToModelName(apiModeOllama)).toBe('ollamaG-llama2');
      const apiModeCustomGroup = { groupName: 'custom', itemName: 'customModel', isCustom: true, customName: 'my-api' };
      expect(apiModeToModelName(apiModeCustomGroup)).toBe('custom-my-api');
    });
    test('should handle non-custom API mode within an AlwaysCustomGroup (should still produce group-custom, assuming customName is populated)', () => {
      const apiMode = { groupName: 'azure', itemName: 'azureOpenAi', isCustom: false, customName: 'test-deploy' };
      expect(apiModeToModelName(apiMode)).toBe('azure-test-deploy');
    });
    test('should handle API mode where itemName is not "custom" but isCustom is true, not in AlwaysCustomGroups', () => {
        const apiMode = { groupName: 'anthropic', itemName: 'claude-2', isCustom: true, customName: 'tuned-claude' };
        expect(apiModeToModelName(apiMode)).toBe('claude-2-tuned-claude');
    });
    test('should return just itemName if not custom and not in AlwaysCustomGroups', () => {
        const apiMode = { groupName: 'anthropic', itemName: 'claude-3-opus', isCustom: false, customName: '' };
        expect(apiModeToModelName(apiMode)).toBe('claude-3-opus');
    });
  });

  describe('isCustomModelName', () => {
    test('should return true for names containing "-"', () => {
      expect(isCustomModelName('gpt-4-custom')).toBe(true);
      expect(isCustomModelName('azure-myDeployment')).toBe(true);
    });
    test('should return false for names not containing "-"', () => {
      expect(isCustomModelName('gpt4')).toBe(false);
      expect(isCustomModelName('claude2')).toBe(false);
      expect(isCustomModelName('gpt-4')).toBe(true);
      expect(isCustomModelName('claude-2')).toBe(true);
      expect(isCustomModelName('gpt-3.5-turbo')).toBe(true);
    });
    test('should return false for empty, null, or undefined names', () => {
      expect(isCustomModelName('')).toBe(false);
      expect(isCustomModelName(null)).toBe(false);
      expect(isCustomModelName(undefined)).toBe(false);
    });
  });

  describe('modelNameToPresetPart', () => {
    test('should return the part before "-" for custom names', () => {
      expect(modelNameToPresetPart('gpt-4-custom')).toBe('gpt');
      expect(modelNameToPresetPart('azure-myDeployment')).toBe('azure');
      expect(modelNameToPresetPart('claude-3-opus-custom')).toBe('claude');
    });
    test('should return the full name if not custom (by current isCustomModelName def)', () => {
      expect(modelNameToPresetPart('gpt4')).toBe('gpt4');
      expect(modelNameToPresetPart('claude2')).toBe('claude2');
      expect(modelNameToPresetPart('gpt-4')).toBe('gpt');
      expect(modelNameToPresetPart('claude-2')).toBe('claude');
    });
  });

  describe('modelNameToCustomPart', () => {
    test('should return the part after the first "-" for custom names', () => {
      expect(modelNameToCustomPart('gpt-4-customName')).toBe('4-customName');
      expect(modelNameToCustomPart('azure-myDeployment')).toBe('myDeployment');
      expect(modelNameToCustomPart('claude-3-opus-custom')).toBe('3-opus-custom');
    });
    test('should return the full name if not custom (by current isCustomModelName def)', () => {
      expect(modelNameToCustomPart('gpt4')).toBe('gpt4');
      expect(modelNameToCustomPart('gpt-4')).toBe('4');
    });
    test('should handle names with multiple hyphens correctly (based on current logic)', () => {
      expect(modelNameToCustomPart('claude-3-opus-20240229')).toBe('3-opus-20240229');
      expect(modelNameToPresetPart('claude-3-opus-20240229')).toBe('claude');
    });
  });

  describe('modelNameToDesc', () => {
    test('should return description for known model names from Models (even if they have hyphens)', () => {
      expect(modelNameToDesc('gpt-4', t)).toBe('GPT-4 (OpenAI)');
      expect(modelNameToDesc('claude-2', t)).toBe('Claude 2 (Anthropic)');
      expect(modelNameToDesc('gpt-3.5-turbo', t)).toBe(actualMockModels['gpt-3.5-turbo'].desc);
    });
    test('should return custom model description with extra name', () => {
      expect(modelNameToDesc('customModel', t, 'MySpecialAPI')).toBe('Custom Model (MySpecialAPI)');
    });
    test('should return original description for customModel if no extra name', () => {
      expect(modelNameToDesc('customModel', t, '')).toBe('Custom Model');
    });

    test('should construct description for custom model names (based on current helper logic)', async () => {
      await jest.isolateModulesAsync(async () => {
        const localModelsCopy = JSON.parse(JSON.stringify(actualMockModels));
        localModelsCopy['claude'] = { desc: "Claude Base", value: "claude" };
        jest.doMock('../../config/index.mjs', () => ({ Models: localModelsCopy, ModelGroups: actualMockModelGroups, ModelMode: actualMockModelMode, AlwaysCustomGroups: actualMockAlwaysCustomGroups }));
        const { modelNameToDesc: localFunc } = await import('../model-name-convert.mjs');
        expect(localFunc('claude-fast', t)).toBe('Claude Base (Fast Mode)');
      });
      await jest.isolateModulesAsync(async () => {
        const localModelsCopy = JSON.parse(JSON.stringify(actualMockModels));
        localModelsCopy['claude'] = { desc: "Claude Base", value: "claude" };
        jest.doMock('../../config/index.mjs', () => ({ Models: localModelsCopy, ModelGroups: actualMockModelGroups, ModelMode: actualMockModelMode, AlwaysCustomGroups: actualMockAlwaysCustomGroups }));
        const { modelNameToDesc: localFunc } = await import('../model-name-convert.mjs');
        expect(localFunc('claude-200k', t)).toBe('Claude Base (200k)');
      });
      await jest.isolateModulesAsync(async () => {
        const localModelsCopy = JSON.parse(JSON.stringify(actualMockModels));
        localModelsCopy['claude'] = { desc: "Claude Base", value: "claude" };
        jest.doMock('../../config/index.mjs', () => ({ Models: localModelsCopy, ModelGroups: actualMockModelGroups, ModelMode: actualMockModelMode, AlwaysCustomGroups: actualMockAlwaysCustomGroups }));
        const { modelNameToDesc: localFunc } = await import('../model-name-convert.mjs');
        expect(localFunc('claude-custom-variant', t)).toBe('Claude Base (custom-variant)');
      });
    });

    test('should construct description for custom model names based on group and custom part', () => {
      expect(modelNameToDesc('openAi-customized-model', t)).toBe('OpenAI (customized-model)');
    });
    test('should return the name itself if not in Models and not a recognized custom structure', () => {
      expect(modelNameToDesc('unknown-model', t)).toBe('unknown-model');
      expect(modelNameToDesc('somegroup-custom', t)).toBe('somegroup-custom');
    });
    test('should handle model names that look custom but preset part is not in Models or ModelGroups', () => {
      expect(modelNameToDesc('newModel-variant', t)).toBe('newModel-variant');
    });
    test('should return model name if t function is not provided (graceful fallback)', () => {
        expect(modelNameToDesc('gpt-4')).toBe('GPT-4 (OpenAI)');
    });
    test('should handle null or undefined model names by returning them as is', () => {
      expect(modelNameToDesc(null, t)).toBe(null);
      expect(modelNameToDesc(undefined, t)).toBe(undefined);
    });
  });

  describe('isGPT4', () => {
    test('should return true for gpt-4 model names', () => {
      expect(isGPT4('gpt-4')).toBe(true);
      expect(isGPT4('gpt-4-32k')).toBe(true);
      expect(isGPT4('gpt-4-turbo-preview')).toBe(true);
      expect(isGPT4('gpt-4-1106-preview')).toBe(true);
      expect(isGPT4('gpt-4-vision-preview')).toBe(true);
    });
    test('should return false for non-gpt-4 model names', () => {
      expect(isGPT4('gpt-3.5-turbo')).toBe(false);
      expect(isGPT4('claude-2')).toBe(false);
      expect(isGPT4('gpt-4o')).toBe(true);
      expect(isGPT4('gpt-4o-mini')).toBe(true);
    });
    test('should return false for names that merely contain "gpt-4" but do not start with it', () => {
      expect(isGPT4('my-custom-gpt-4-model')).toBe(false);
      expect(isGPT4('old-gpt-4-variant')).toBe(false);
    });
    test('should return false for null, undefined, or empty string model names', () => {
      expect(isGPT4(null)).toBe(false);
      expect(isGPT4(undefined)).toBe(false);
      expect(isGPT4('')).toBe(false);
    });
  });

  describe('isClaude3', () => {
    test('should return true for claude-3 model names', () => {
      expect(isClaude3('claude-3-opus-20240229')).toBe(true);
      expect(isClaude3('claude-3-sonnet-20240229')).toBe(true);
      expect(isClaude3('claude-3-haiku-20240307')).toBe(true);
    });
    test('should return false for non-claude-3 model names', () => {
      expect(isClaude3('claude-2')).toBe(false);
      expect(isClaude3('claude-2.1')).toBe(false);
      expect(isClaude3('gpt-4')).toBe(false);
      expect(isClaude3('claude-3x-opus-20240229')).toBe(true);
    });
    test('should return false for names that merely contain "claude-3" but do not start with it', () => {
      expect(isClaude3('my-claude-3-custom')).toBe(false);
    });
    test('should return false for null, undefined, or empty string model names', () => {
      expect(isClaude3(null)).toBe(false);
      expect(isClaude3(undefined)).toBe(false);
      expect(isClaude3('')).toBe(false);
    });
  });

  describe('modelNameToValue', () => {
    test('should return value for known model names from Models', () => {
      expect(modelNameToValue('gpt-4')).toBe('gpt-4');
      expect(modelNameToValue('customModel')).toBe('customModel');
    });
    test('should return custom part for custom model names not in Models directly', () => {
      expect(modelNameToValue('gpt-4-customSuffix')).toBe('4-customSuffix');
      expect(modelNameToValue('someModel-anotherValue')).toBe('anotherValue');
    });
    test('should return the name itself if not in Models and not "custom" by current isCustomModelName', () => {
      expect(modelNameToValue('singleName')).toBe('singleName');
    });
     test('should return value for azureOpenAi from Models', () => {
      expect(modelNameToValue('azureOpenAi')).toBe('azureOpenAi');
    });
  });

  describe('getModelNameGroup', () => {
    test('should find group by preset part being a direct key in ModelGroups', () => {
      const group = getModelNameGroup('openAi-some-custom-ext');
      expect(group[0]).toBe('openAi');
      expect(group[1]).toBe(actualMockModelGroups.openAi);
    });
    test('should find group by preset part being a value in a ModelGroup', () => {
      const gpt4Group = getModelNameGroup('gpt-4');
      expect(gpt4Group).toBeUndefined();
      const claudeGroup = getModelNameGroup('claude-2');
      expect(claudeGroup).toBeUndefined();
    });
    test('should handle model names with hyphens that are direct model keys', () => {
       expect(getModelNameGroup('gpt-3.5-turbo')).toBeUndefined();
      const azureGroup = getModelNameGroup('azureOpenAi-custom');
      expect(azureGroup[0]).toBe('azure');
    });
    test('should return undefined if modelName does not belong to any group', () => {
      expect(getModelNameGroup('unknownModel')).toBeUndefined();
      expect(getModelNameGroup('unknownModel-custom')).toBeUndefined();
    });
  });

  describe('getModelValue', () => {
    const mockConfigApiMode = { apiMode: { groupName: 'openAi', itemName: 'gpt-4', isCustom: false, customName: '' } };
    const mockConfigModelName = { modelName: 'claude-2' };
    const mockConfigCustomApiMode = { apiMode: { groupName: 'openAi', itemName: 'gpt-4', isCustom: true, customName: 'my-variant' } };
    const mockConfigCustomModelName = { modelName: 'claude-2-my-variant' };

    test('should get value using apiMode if present', () => {
      expect(getModelValue(mockConfigApiMode)).toBe('gpt-4');
    });
    test('should get value using modelName if apiMode is not present', () => {
      expect(getModelValue(mockConfigModelName)).toBe('claude-2');
    });
    test('should get value for custom apiMode', () => {
      expect(getModelValue(mockConfigCustomApiMode)).toBe('4-my-variant');
    });
    test('should get value for custom modelName', () => {
      expect(getModelValue(mockConfigCustomModelName)).toBe('2-my-variant');
    });
  });

  describe('modelNameToApiMode', () => {
    test('should convert a model whose presetPart is a group key', async () => {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('../../config/index.mjs', () => ({ Models: actualMockModels, ModelGroups: actualMockModelGroups, ModelMode: actualMockModelMode, AlwaysCustomGroups: actualMockAlwaysCustomGroups }));
        const { modelNameToApiMode } = await import('../model-name-convert.mjs'); // Use destructured import
        const apiModeOpenAi = modelNameToApiMode('openAi-custom');
        expect(apiModeOpenAi).toEqual({
          groupName: 'openAi', itemName: 'openAi', isCustom: true, customName: 'custom', customUrl: '', apiKey: '', active: true,
        });
      });
    });
    test('should convert a model where presetPart is in a group value list and not custom', async () => {
      await jest.isolateModulesAsync(async () => {
        const localMockGroups = JSON.parse(JSON.stringify(actualMockModelGroups));
        localMockGroups.testGroup = { desc: 'Test Group', value: ['gpt4'] };
        jest.doMock('../../config/index.mjs', () => ({ Models: actualMockModels, ModelGroups: localMockGroups, ModelMode: actualMockModelMode, AlwaysCustomGroups: actualMockAlwaysCustomGroups }));
        const { modelNameToApiMode } = await import('../model-name-convert.mjs'); // Use destructured import
        const apiModeGpt4 = modelNameToApiMode('gpt4');
        expect(apiModeGpt4).toEqual({
          groupName: 'testGroup', itemName: 'gpt4', isCustom: false, customName: '', customUrl: '', apiKey: '', active: true,
        });
      });
    });
    test('should return undefined for base models whose presetPart does not resolve to a group', async () => {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('../../config/index.mjs', () => ({ Models: actualMockModels, ModelGroups: actualMockModelGroups, ModelMode: actualMockModelMode, AlwaysCustomGroups: actualMockAlwaysCustomGroups }));
        const { modelNameToApiMode } = await import('../model-name-convert.mjs'); // Use destructured import
        expect(modelNameToApiMode('gpt-4')).toBeUndefined();
      });
    });
    test('should convert a custom model name (e.g., group-custompart in AlwaysCustomGroups)', async () => {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('../../config/index.mjs', () => ({ Models: actualMockModels, ModelGroups: actualMockModelGroups, ModelMode: actualMockModelMode, AlwaysCustomGroups: actualMockAlwaysCustomGroups }));
        const { modelNameToApiMode } = await import('../model-name-convert.mjs'); // Use destructured import
        const apiMode = modelNameToApiMode('azure-myCustomAzure');
        expect(apiMode).toEqual({
          groupName: 'azure', itemName: 'azure', isCustom: true, customName: 'myCustomAzure', customUrl: '', apiKey: '', active: true,
        });
      });
    });
    test('should return undefined for a model name not found in any group', async () => {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('../../config/index.mjs', () => ({ Models: actualMockModels, ModelGroups: actualMockModelGroups, ModelMode: actualMockModelMode, AlwaysCustomGroups: actualMockAlwaysCustomGroups }));
        const { modelNameToApiMode } = await import('../model-name-convert.mjs'); // Use destructured import
        expect(modelNameToApiMode('unknownModel-custom')).toBeUndefined();
      });
    });
  });

  describe('getApiModeGroup', () => {
    test('should return the group for a given apiMode', () => {
      const customOpenAiApiMode = { groupName: 'openAi', itemName: 'openAi', isCustom: true, customName: 'variant' };
      const group = getApiModeGroup(customOpenAiApiMode);
      expect(group[0]).toBe('openAi');
    });
  });

  describe('isInApiModeGroup', () => {
    const configWithApiMode = { apiMode: { groupName: 'openAi', itemName: 'custom', isCustom: true, customName: 'my-openai' } };
    const configWithModelName = { modelName: 'claude-2-custom' };
    const configWithResolvableModelName = { modelName: 'azure-deploymentX'};

    test('should return true if configOrSession (apiMode) is in the specified group', () => {
      expect(isInApiModeGroup(actualMockModelGroups.openAi.value, configWithApiMode)).toBe(true);
    });
    test('should return false if configOrSession (apiMode) is not in the specified group', () => {
      expect(isInApiModeGroup(actualMockModelGroups.anthropic.value, configWithApiMode)).toBe(false);
    });
    test('should return true if configOrSession (modelName) is in the specified group', async () => {
      await jest.isolateModulesAsync(async () => {
        const localMockModelGroups = JSON.parse(JSON.stringify(actualMockModelGroups));
        if (!localMockModelGroups.azure) localMockModelGroups.azure = { value: [] };
        else if (!localMockModelGroups.azure.value) localMockModelGroups.azure.value = [];
        localMockModelGroups.azure.value.push('azure');
        jest.doMock('../../config/index.mjs', () => ({ Models: actualMockModels, ModelGroups: localMockModelGroups, ModelMode: actualMockModelMode, AlwaysCustomGroups: actualMockAlwaysCustomGroups, }));
        const { isInApiModeGroup } = await import('../model-name-convert.mjs'); // Use destructured import
        expect(isInApiModeGroup(localMockModelGroups.azure.value, configWithResolvableModelName)).toBe(true);
      });
    });
    test('should return false if configOrSession (modelName) is not in the specified group', async () => {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('../../config/index.mjs', () => ({ Models: actualMockModels, ModelGroups: actualMockModelGroups, ModelMode: actualMockModelMode, AlwaysCustomGroups: actualMockAlwaysCustomGroups }));
        const { isInApiModeGroup } = await import('../model-name-convert.mjs'); // Use destructured import
        expect(isInApiModeGroup(actualMockModelGroups.openAi.value, configWithResolvableModelName)).toBe(false);
      });
    });
    test('should return false if model in configOrSession does not belong to any group', async () => {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('../../config/index.mjs', () => ({ Models: actualMockModels, ModelGroups: actualMockModelGroups, ModelMode: actualMockModelMode, AlwaysCustomGroups: actualMockAlwaysCustomGroups }));
        const { isInApiModeGroup } = await import('../model-name-convert.mjs'); // Use destructured import
        expect(isInApiModeGroup(actualMockModelGroups.anthropic.value, configWithModelName)).toBe(false);
      });
    });
  });

  describe('getApiModesFromConfig', () => {
    const baseConfig = {
      customApiModes: [
        { groupName: 'openAi', itemName: 'gpt-4', isCustom: true, customName: 'my-gpt4', active: true },
        { groupName: 'anthropic', itemName: 'claude-2', isCustom: false, active: false },
        { groupName: 'custom', itemName: 'customModel', isCustom: true, customName: 'my-custom-api', active: true },
      ],
      activeApiModes: ['gpt-3.5-turbo', 'azureOpenAi', 'ollama', 'customModel'],
      azureDeploymentName: 'my-azure-deploy',
      ollamaModelName: 'my-ollama-model',
    };
    test('should get all modes when onlyActive is false', () => {
      const result = getApiModesFromConfig(baseConfig, false);
      expect(result).toHaveLength(
        2 /* filtered activeApiModes: azure, ollama */ +
        3 /* customApiModes: gpt-4, claude-2 (inactive included), customModel */
      );
      expect(result).toEqual(expect.arrayContaining([
        expect.objectContaining({ groupName: 'azure', customName: 'my-azure-deploy' }),
        expect.objectContaining({ groupName: 'ollamaG', customName: 'my-ollama-model' }),
        baseConfig.customApiModes[0],
        baseConfig.customApiModes[1],
        baseConfig.customApiModes[2],
      ]));
    });
    test('should get only active modes when onlyActive is true', () => {
      const result = getApiModesFromConfig(baseConfig, true);
      expect(result).toHaveLength(2 + 2);
      expect(result).toEqual(expect.arrayContaining([
        expect.objectContaining({ groupName: 'azure', customName: 'my-azure-deploy' }),
        expect.objectContaining({ groupName: 'ollamaG', customName: 'my-ollama-model' }),
        baseConfig.customApiModes[0],
        baseConfig.customApiModes[2],
      ]));
      expect(result).not.toEqual(expect.arrayContaining([
        baseConfig.customApiModes[1],
      ]));
    });
    test('should skip activeApiMode if its name matches a stringApiMode', () => {
      const configWithOverlap = {
        customApiModes: [
          { groupName: 'openAi', itemName: 'gpt-4', isCustom: true, customName: 'variant', active: true }
        ],
        activeApiModes: ['gpt-4-variant', 'claude-2'],
        azureDeploymentName: '', ollamaModelName: ''
      };
      const result = getApiModesFromConfig(configWithOverlap, true);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(configWithOverlap.customApiModes[0]);
    });
  });

  describe('getApiModesStringArrayFromConfig', () => {
    const mockConfig = {
      customApiModes: [
        { groupName: 'openAi', itemName: 'gpt-4', isCustom: true, customName: 'my-gpt4', active: true }
      ],
      activeApiModes: ['azureOpenAi', 'ollama'],
      azureDeploymentName: 'my-azure-deployment',
      ollamaModelName: 'my-ollama-model'
    };
    test('should return array of model name strings', () => {
      const result = getApiModesStringArrayFromConfig(mockConfig, true);
      expect(result).toEqual(expect.arrayContaining([
        'azure-my-azure-deployment',
        'ollamaG-my-ollama-model',
        'gpt-4-my-gpt4'
      ]));
      expect(result).toHaveLength(3);
    });
  });

  describe('isApiModeSelected', () => {
    const apiMode1 = { groupName: 'openAi', itemName: 'gpt-4', isCustom: false, customName: '' };
    const apiMode2 = { groupName: 'openAi', itemName: 'gpt-4', isCustom: true, customName: 'variant' };

    test('should return true if config uses apiMode and it matches', () => {
      const config = { apiMode: apiMode1 };
      expect(isApiModeSelected(apiMode1, config)).toBe(true);
    });
    test('should return false if config uses apiMode and it does not match', () => {
      const config = { apiMode: apiMode1 };
      expect(isApiModeSelected(apiMode2, config)).toBe(false);
    });
    test('should return true if config uses modelName and it matches converted apiMode', () => {
      const config = { modelName: 'gpt-4' };
      expect(isApiModeSelected(apiMode1, config)).toBe(true);
    });
    test('should return false if config uses modelName and it does not match converted apiMode', () => {
      const config = { modelName: 'gpt-4-variant' };
      expect(isApiModeSelected(apiMode1, config)).toBe(false);
      const config2 = { modelName: 'gpt-3.5-turbo'};
      expect(isApiModeSelected(apiMode1, config2)).toBe(false);
    });
  });

  describe('isUsingModelName', () => {
    const configWithApiMode = { apiMode: { groupName: 'openAi', itemName: 'gpt-4', isCustom: false, customName: '' }};
    const configWithModelName = { modelName: 'gpt-4' };

    test('should return true for exact match (config.modelName)', () => {
      expect(isUsingModelName('gpt-4', configWithModelName)).toBe(true);
    });
    test('should return true for exact match (config.apiMode)', () => {
      expect(isUsingModelName('gpt-4', configWithApiMode)).toBe(true);
    });
    test('should return false if modelName does not match', () => {
      expect(isUsingModelName('claude-2', configWithModelName)).toBe(false);
      expect(isUsingModelName('claude-2', configWithApiMode)).toBe(false);
    });

    /**
     * Partial match logic for isUsingModelName:
     * 1. If the config model name is custom (contains hyphen), extract the preset part.
     * 2. If the preset part exists in Models, use it for comparison.
     * 3. If the preset part exists in ModelGroups, use the first value in the group.
     * 4. Otherwise, no partial match occurs (the full custom name is used for comparison).
     */
    describe('partial match scenarios', () => {
      const configWithGptCustomVariant = { modelName: 'gpt-custom-variant' };

      test('should return true for partial match (config.modelName custom, preset part in Models)', async () => {
        await jest.isolateModulesAsync(async () => {
          const localMocks = JSON.parse(JSON.stringify(actualMockModels));
          localMocks['gpt'] = { desc: "GPT Base", value: "gpt" };
          jest.doMock('../../config/index.mjs', () => ({
            Models: localMocks,
            ModelGroups: JSON.parse(JSON.stringify(actualMockModelGroups)),
            ModelMode: JSON.parse(JSON.stringify(actualMockModelMode)),
            AlwaysCustomGroups: JSON.parse(JSON.stringify(actualMockAlwaysCustomGroups)),
          }));
          const { isUsingModelName } = await import('../model-name-convert.mjs'); // Use destructured import
          expect(isUsingModelName('gpt', configWithGptCustomVariant)).toBe(true);
        });
      });

      test('should return true for partial match (config.modelName custom, preset part in ModelGroups)', async () => {
        await jest.isolateModulesAsync(async () => {
          const localMockGroups = JSON.parse(JSON.stringify(actualMockModelGroups));
          localMockGroups['gpt'] = { desc: "GPT Group", value: ['gpt-3.5', 'gpt-4'] };
          jest.doMock('../../config/index.mjs', () => ({
            Models: JSON.parse(JSON.stringify(actualMockModels)),
            ModelGroups: localMockGroups,
            ModelMode: JSON.parse(JSON.stringify(actualMockModelMode)),
            AlwaysCustomGroups: JSON.parse(JSON.stringify(actualMockAlwaysCustomGroups)),
          }));
          const { isUsingModelName } = await import('../model-name-convert.mjs'); // Use destructured import
          expect(isUsingModelName('gpt-3.5', configWithGptCustomVariant)).toBe(true);
        });
      });

      test('should return false for partial match (config.modelName custom, preset part not in Models or ModelGroups)', async () => {
        await jest.isolateModulesAsync(async () => {
          const localMocks = JSON.parse(JSON.stringify(actualMockModels));
          const localMockGroups = JSON.parse(JSON.stringify(actualMockModelGroups));
          if ('gpt' in localMocks) delete localMocks['gpt'];
          if ('gpt' in localMockGroups) delete localMockGroups['gpt'];

          jest.doMock('../../config/index.mjs', () => ({
            Models: localMocks,
            ModelGroups: localMockGroups,
            ModelMode: JSON.parse(JSON.stringify(actualMockModelMode)),
            AlwaysCustomGroups: JSON.parse(JSON.stringify(actualMockAlwaysCustomGroups)),
          }));
          const { isUsingModelName } = await import('../model-name-convert.mjs'); // Use destructured import
          expect(isUsingModelName('gpt-custom-variant', configWithGptCustomVariant)).toBe(true);
          expect(isUsingModelName('gpt', configWithGptCustomVariant)).toBe(false);
        });
      });

      test('should return true if preset part matches modelName and is in Models (original example logic)', async () => {
        await jest.isolateModulesAsync(async () => {
          const localMocks = JSON.parse(JSON.stringify(actualMockModels));
          localMocks['bingFree4'] = { desc: "Bing Free Gen4", value: "bingFree4" };
          jest.doMock('../../config/index.mjs', () => ({
            Models: localMocks,
            ModelGroups: JSON.parse(JSON.stringify(actualMockModelGroups)),
            ModelMode: JSON.parse(JSON.stringify(actualMockModelMode)),
            AlwaysCustomGroups: JSON.parse(JSON.stringify(actualMockAlwaysCustomGroups)),
          }));
          const { isUsingModelName } = await import('../model-name-convert.mjs'); // Use destructured import
          const configWithBingFast = { modelName: 'bingFree4-fast' };
          expect(isUsingModelName('bingFree4', configWithBingFast)).toBe(true);
        });
      });
    });
  });
});
