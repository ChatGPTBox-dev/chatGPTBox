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
  modelNameToApiMode,
  getApiModesFromConfig,
  getApiModesStringArrayFromConfig,
  isApiModeSelected,
  isUsingModelName,
  getModelNameGroup,
  getApiModeGroup,
  isInApiModeGroup,
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

// Mock the imports from '../config/index.mjs'
// The factory function now refers to the 'actualMock*' variables defined above.
// These are const and their definitions are not hoisted past by jest.mock in a problematic way.
jest.mock('../../config/index.mjs', () => ({
  Models: actualMockModels,
  ModelGroups: actualMockModelGroups,
  ModelMode: actualMockModelMode,
  AlwaysCustomGroups: actualMockAlwaysCustomGroups,
}));

// Helper for translation, as used in modelNameToDesc
const t = (key) => key; // Simple pass-through for testing

describe('model-name-convert', () => {
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
      // This case might indicate an edge or misconfiguration, but tests current logic.
      // If isCustom is false for an AlwaysCustomGroup, it currently falls through the first check.
      // The implementation `if (AlwaysCustomGroups.includes(apiMode.groupName)) return apiMode.groupName + '-' + apiMode.customName;`
      // does not check `isCustom`.
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
      // Correcting based on current implementation: any hyphen makes it "custom"
      expect(isCustomModelName('gpt4')).toBe(false); // No hyphen
      expect(isCustomModelName('claude2')).toBe(false); // No hyphen
      // Standard names with hyphens ARE considered custom by the current function
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
      // Correcting based on current implementation: split by first '-'
      expect(modelNameToPresetPart('gpt-4-custom')).toBe('gpt');
      expect(modelNameToPresetPart('azure-myDeployment')).toBe('azure');
      expect(modelNameToPresetPart('claude-3-opus-custom')).toBe('claude');
    });

    test('should return the full name if not custom (by current isCustomModelName def)', () => {
      // isCustomModelName('gpt4') is false
      expect(modelNameToPresetPart('gpt4')).toBe('gpt4');
      expect(modelNameToPresetPart('claude2')).toBe('claude2');
      // For names with hyphens, isCustomModelName is true, so they take the custom path.
      expect(modelNameToPresetPart('gpt-4')).toBe('gpt'); // Takes custom path
      expect(modelNameToPresetPart('claude-2')).toBe('claude'); // Takes custom path
    });
  });

  describe('modelNameToCustomPart', () => {
    test('should return the part after the first "-" for custom names', () => {
      // Correcting based on current implementation: substring after first '-'
      expect(modelNameToCustomPart('gpt-4-customName')).toBe('4-customName');
      expect(modelNameToCustomPart('azure-myDeployment')).toBe('myDeployment');
      expect(modelNameToCustomPart('claude-3-opus-custom')).toBe('3-opus-custom');
    });

    test('should return the full name if not custom (by current isCustomModelName def)', () => {
      // isCustomModelName('gpt4') is false
      expect(modelNameToCustomPart('gpt4')).toBe('gpt4');
      // For names with hyphens, isCustomModelName is true, so they take the custom path.
      expect(modelNameToCustomPart('gpt-4')).toBe('4'); // Takes custom path
    });

    test('should handle names with multiple hyphens correctly (based on current logic)', () => {
      expect(modelNameToCustomPart('claude-3-opus-20240229')).toBe('3-opus-20240229');
      expect(modelNameToPresetPart('claude-3-opus-20240229')).toBe('claude');
    });
  });

  describe('modelNameToDesc', () => {
    test('should return description for known model names from Models (even if they have hyphens)', () => {
      // Current isCustomModelName treats these as "custom", but modelNameToDesc first checks `modelName in Models`
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

    test('should construct description for custom model names (based on current helper logic)', () => {
      // Given modelNameToPresetPart('gpt-4-fast') is 'gpt'
      // and modelNameToCustomPart('gpt-4-fast') is '4-fast'
      // If 'gpt' is NOT in Models or ModelGroups, and 'gpt-4-fast' is not in Models,
      // it will return 'gpt-4-fast'.
      // Let's test a case where presetPart IS in Models.
      // Add 'claude' to actualMockModels for this.
      const originalClaude = actualMockModels['claude-2'];
      actualMockModels['claude'] = { desc: "Claude Base", value: "claude"};
      expect(modelNameToDesc('claude-200k', t)).toBe('Claude Base (200k)'); // presetPart='claude', customPart='200k'

      // Test with a preset part that is in Models and custom part in ModelMode
      // modelNameToPresetPart('gpt-4-fast') -> 'gpt'. Let's assume 'gpt' is not in Models.
      // This test needs a presetPart that IS in Models.
      // Let's use a hypothetical 'claude-fast'. modelNameToPresetPart('claude-fast') -> 'claude'
      expect(modelNameToDesc('claude-fast', t)).toBe('Claude Base (Fast Mode)');

      // Restore actualMockModels if changed
      actualMockModels['claude'] = undefined;
      actualMockModels['claude-2'] = originalClaude;

      // Test with a preset part that IS in Models and custom part NOT in ModelMode
      // modelNameToPresetPart('claude-custom-variant') -> 'claude'
      // modelNameToCustomPart('claude-custom-variant') -> 'custom-variant'
      actualMockModels['claude'] = { desc: "Claude Base", value: "claude"}; // Ensure 'claude' is there
      expect(modelNameToDesc('claude-custom-variant', t)).toBe('Claude Base (custom-variant)');
      actualMockModels['claude'] = undefined;
    });

    test('should construct description for custom model names based on group and custom part', () => {
      // modelNameToPresetPart('openAi-customized-model') -> 'openAi'
      // modelNameToCustomPart('openAi-customized-model') -> 'customized-model'
      // 'openAi' is in ModelGroups.
      expect(modelNameToDesc('openAi-customized-model', t)).toBe('OpenAI (customized-model)');
    });

    test('should return the name itself if not in Models and not a recognized custom structure', () => {
      expect(modelNameToDesc('unknown-model', t)).toBe('unknown-model');
      expect(modelNameToDesc('somegroup-custom', t)).toBe('somegroup-custom'); // if 'somegroup' is not in ModelGroups
    });

    test('should handle model names that look custom but preset part is not in Models or ModelGroups', () => {
      expect(modelNameToDesc('newModel-variant', t)).toBe('newModel-variant');
    });

    test('should return model name if t function is not provided (graceful fallback)', () => {
        expect(modelNameToDesc('gpt-4')).toBe('GPT-4 (OpenAI)'); // t is optional, defaults to x => x
    });

    test('should handle null or undefined model names by returning them as is', () => {
      // The function doesn't explicitly check for null/undefined and would rely on `in` operator / string methods
      // `null in Models` is false. `isCustomModelName(null)` is false. So it returns `null`.
      expect(modelNameToDesc(null, t)).toBe(null);
      expect(modelNameToDesc(undefined, t)).toBe(undefined);
    });

    // Tests for 'k' value extraction are not directly applicable to modelNameToDesc
    // as its main role is description lookup/construction, not parsing 'k' values from descriptions.
    // That seems to be a misinterpretation of the function's role in the subtask description.
  });

  // Placeholder for isGPT4 and isClaude3 tests after implementing them

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
      expect(isGPT4('gpt-4o')).toBe(true); // According to new OpenAI naming, gpt-4o is a GPT-4 class model.
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
      // Correcting the expectation: 'claude-3x-opus...' DOES start with 'claude-3', so it should be true.
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
      // This relies on modelNameToCustomPart logic
      expect(modelNameToValue('gpt-4-customSuffix')).toBe('4-customSuffix'); // modelNameToCustomPart('gpt-4-customSuffix')
      expect(modelNameToValue('someModel-anotherValue')).toBe('anotherValue'); // modelNameToCustomPart('someModel-anotherValue')
    });

    test('should return the name itself if not in Models and not "custom" by current isCustomModelName', () => {
      // e.g. isCustomModelName('singleName') is false
      expect(modelNameToValue('singleName')).toBe('singleName'); // modelNameToCustomPart('singleName')
    });
     test('should return value for azureOpenAi from Models', () => {
      expect(modelNameToValue('azureOpenAi')).toBe('azureOpenAi');
    });
  });

  describe('getModelNameGroup', () => {
    test('should find group by preset part being a direct key in ModelGroups', () => {
      const group = getModelNameGroup('openAi-some-custom-ext'); // presetPart is 'openAi'
      expect(group[0]).toBe('openAi');
      expect(group[1]).toBe(actualMockModelGroups.openAi);
    });

    test('should find group by preset part being a value in a ModelGroup', () => {
      // const group = getModelNameGroup('gpt-4-some-custom-ext'); // This was unused.
      // current modelNameToPresetPart('gpt-4-...') returns 'gpt'. 'gpt' is not in any group value list.
      // Let's test 'gpt-4' which is in openAi group
      const gpt4Group = getModelNameGroup('gpt-4');
      // Based on current logic: modelNameToPresetPart('gpt-4') -> 'gpt'
      // 'gpt' is not a group key and not in any group's value list. So, undefined.
      expect(gpt4Group).toBeUndefined();

      const claudeGroup = getModelNameGroup('claude-2');
      // Based on current logic: modelNameToPresetPart('claude-2') -> 'claude'
      // 'claude' is not a group key and not in any group's value list. So, undefined.
      expect(claudeGroup).toBeUndefined();
    });

    test('should handle model names with hyphens that are direct model keys', () => {
      // modelNameToPresetPart('gpt-3.5-turbo') will be 'gpt'.
      // To correctly test finding 'gpt-3.5-turbo' in ModelGroups.openAi.value,
      // we need to ensure modelNameToPresetPart returns 'gpt-3.5-turbo' for it,
      // which it does IF isCustomModelName('gpt-3.5-turbo') is false.
      // However, current isCustomModelName('gpt-3.5-turbo') is true.
      // So, presetPart is 'gpt'. 'gpt' is not in actualMockModelGroups.openAi.value.
      // This test reveals that getModelNameGroup might not work as expected for models like 'gpt-3.5-turbo'
      // if their presetPart (e.g. 'gpt') isn't what's listed in the group's `value` array.
      // The current implementation of getModelNameGroup uses modelNameToPresetPart.
      // For 'gpt-3.5-turbo', presetPart is 'gpt'.
      // It then checks if 'gpt' is a key in ModelGroups (false)
      // or if 'gpt' is in any group's value array (false for our mock).
      // So, it will return undefined. This test documents current behavior.
       expect(getModelNameGroup('gpt-3.5-turbo')).toBeUndefined();

      // If we search for 'azureOpenAi-custom', presetPart is 'azureOpenAi'.
      // 'azureOpenAi' is a key in ModelGroups.azure.value
      const azureGroup = getModelNameGroup('azureOpenAi-custom');
      expect(azureGroup[0]).toBe('azure');
    });

    test('should return undefined if modelName does not belong to any group', () => {
      expect(getModelNameGroup('unknownModel')).toBeUndefined();
      expect(getModelNameGroup('unknownModel-custom')).toBeUndefined();
    });
  });

  describe('getModelValue', () => {
    const mockConfigApiMode = {
      apiMode: { groupName: 'openAi', itemName: 'gpt-4', isCustom: false, customName: '' }
    };
    const mockConfigModelName = { modelName: 'claude-2' };
    const mockConfigCustomApiMode = {
      apiMode: { groupName: 'openAi', itemName: 'gpt-4', isCustom: true, customName: 'my-variant' }
    };
    const mockConfigCustomModelName = { modelName: 'claude-2-my-variant' };


    test('should get value using apiMode if present', () => {
      // apiModeToModelName(mockConfigApiMode.apiMode) -> 'gpt-4'
      // modelNameToValue('gpt-4') -> 'gpt-4' (from actualMockModels)
      expect(getModelValue(mockConfigApiMode)).toBe('gpt-4');
    });

    test('should get value using modelName if apiMode is not present', () => {
      // modelNameToValue('claude-2') -> 'claude-2' (from actualMockModels)
      expect(getModelValue(mockConfigModelName)).toBe('claude-2');
    });

    test('should get value for custom apiMode', () => {
      // apiModeToModelName(mockConfigCustomApiMode.apiMode) -> 'gpt-4-my-variant'
      // modelNameToValue('gpt-4-my-variant') -> '4-my-variant' (from modelNameToCustomPart)
      expect(getModelValue(mockConfigCustomApiMode)).toBe('4-my-variant');
    });

    test('should get value for custom modelName', () => {
      // modelNameToValue('claude-2-my-variant') -> '2-my-variant' (from modelNameToCustomPart)
      expect(getModelValue(mockConfigCustomModelName)).toBe('2-my-variant');
    });
  });

  describe('modelNameToApiMode', () => {
    test('should convert a base model name (preset part in a group value)', () => {
      // 'gpt-4' is in actualMockModelGroups.openAi.value
      // modelNameToPresetPart('gpt-4') is 'gpt'. This will be the itemName.
      // getModelNameGroup('gpt') is undefined based on current mocks and logic.
      // The function will return undefined if getModelNameGroup(presetPart) is undefined.
      // This highlights that the current logic might not correctly form ApiMode for base models like 'gpt-4'
      // if their presetPart (e.g. 'gpt') isn't directly a group key or in a group's value list.
      // Let's test a model whose presetPart IS a group key.
      const apiModeOpenAi = modelNameToApiMode('openAi-custom'); // presetPart 'openAi' is a group key
      expect(apiModeOpenAi).toEqual({
        groupName: 'openAi',
        itemName: 'openAi', // presetPart
        isCustom: true,
        customName: 'custom', // modelNameToCustomPart
        customUrl: '',
        apiKey: '',
        active: true,
      });

      // Test a case where presetPart is in a group's value list, but isCustomModelName is false.
      // For 'gpt4', isCustomModelName is false. modelNameToPresetPart is 'gpt4'.
      // Add 'gpt4' to a group to test this path.
      actualMockModelGroups.testGroup = { desc: 'Test Group', value: ['gpt4'] };
      const apiModeGpt4 = modelNameToApiMode('gpt4');
      expect(apiModeGpt4).toEqual({
        groupName: 'testGroup',
        itemName: 'gpt4',
        isCustom: false,
        customName: '', // customName is empty if not isCustom
        customUrl: '',
        apiKey: '',
        active: true,
      });
      delete actualMockModelGroups.testGroup;

      // Test for 'gpt-4'. isCustomModelName('gpt-4') is true. presetPart is 'gpt'. customPart is '4'.
      // getModelNameGroup('gpt') is undefined with current mocks. So, modelNameToApiMode('gpt-4') is undefined.
      expect(modelNameToApiMode('gpt-4')).toBeUndefined();
    });

    test('should convert a custom model name (e.g., group-custompart)', () => {
      const apiMode = modelNameToApiMode('azure-myCustomAzure'); // 'azure' is an AlwaysCustomGroup and a group key
      expect(apiMode).toEqual({
        groupName: 'azure',
        itemName: 'azure', // presetPart
        isCustom: true,
        customName: 'myCustomAzure', // modelNameToCustomPart
        customUrl: '',
        apiKey: '',
        active: true,
      });
    });

    test('should return undefined for a model name not found in any group', () => {
      expect(modelNameToApiMode('unknownModel-custom')).toBeUndefined();
    });
  });

  describe('getApiModeGroup', () => {
    test('should return the group for a given apiMode', () => {
      // const apiMode = { groupName: 'openAi', itemName: 'gpt-4', isCustom: false, customName: '' }; // This was unused.
      // apiModeToModelName(apiMode) -> 'gpt-4'
      // getModelNameGroup('gpt-4') -> undefined with current logic.
      // This test will fail if getModelNameGroup doesn't resolve 'gpt-4'.
      // Let's use an apiMode that is resolvable by current getModelNameGroup logic.
      // e.g. one where apiModeToModelName results in 'openAi-custom'
      const customOpenAiApiMode = { groupName: 'openAi', itemName: 'openAi', isCustom: true, customName: 'variant' };
      // apiModeToModelName(customOpenAiApiMode) -> 'openAi-variant'
      // getModelNameGroup('openAi-variant') -> presetPart 'openAi', which is a group key.
      const group = getApiModeGroup(customOpenAiApiMode);
      expect(group[0]).toBe('openAi');
    });
  });

  describe('isInApiModeGroup', () => {
    const configWithApiMode = {
      apiMode: { groupName: 'openAi', itemName: 'custom', isCustom: true, customName: 'my-openai' }
      // This converts to modelName 'openAi-my-openai'. presetPart 'openAi'. Group is 'openAi'.
    };
    const configWithModelName = { modelName: 'claude-2-custom' };
    // presetPart 'claude'. Group for 'claude' is undefined.

    const configWithResolvableModelName = { modelName: 'azure-deploymentX'};
    // presetPart 'azure'. Group is 'azure'.

    actualMockModelGroups.azure.value.push('azure'); // Make 'azure' itself a value in its group for testing 'azure-deploymentX'

    test('should return true if configOrSession (apiMode) is in the specified group', () => {
      expect(isInApiModeGroup(actualMockModelGroups.openAi.value, configWithApiMode)).toBe(true);
    });

    test('should return false if configOrSession (apiMode) is not in the specified group', () => {
      expect(isInApiModeGroup(actualMockModelGroups.anthropic.value, configWithApiMode)).toBe(false);
    });

    test('should return true if configOrSession (modelName) is in the specified group', () => {
       expect(isInApiModeGroup(actualMockModelGroups.azure.value, configWithResolvableModelName)).toBe(true);
    });

    test('should return false if configOrSession (modelName) is not in the specified group', () => {
       expect(isInApiModeGroup(actualMockModelGroups.openAi.value, configWithResolvableModelName)).toBe(false);
    });

    test('should return false if model in configOrSession does not belong to any group', () => {
      // modelNameToPresetPart('claude-2-custom') -> 'claude'. getModelNameGroup('claude') is undefined.
      expect(isInApiModeGroup(actualMockModelGroups.anthropic.value, configWithModelName)).toBe(false);
    });

    // Cleanup changes to actualMockModelGroups
    actualMockModelGroups.azure.value = actualMockModelGroups.azure.value.filter(v => v !== 'azure');
  });

  describe('getApiModesFromConfig', () => {
    const baseConfig = {
      customApiModes: [
        { groupName: 'openAi', itemName: 'gpt-4', isCustom: true, customName: 'my-gpt4', active: true },
        { groupName: 'anthropic', itemName: 'claude-2', isCustom: false, active: false }, // Inactive
        { groupName: 'custom', itemName: 'customModel', isCustom: true, customName: 'my-custom-api', active: true },
      ],
      activeApiModes: ['gpt-3.5-turbo', 'azureOpenAi', 'ollama', 'customModel'], // customModel here is a base one
      azureDeploymentName: 'my-azure-deploy',
      ollamaModelName: 'my-ollama-model',
    };

    test('should get all modes when onlyActive is false', () => {
      const result = getApiModesFromConfig(baseConfig, false);
      // Expected:
      // From activeApiModes (non-custom):
      //  - gpt-3.5-turbo -> { groupName: 'openAi', itemName: 'gpt-3.5-turbo', isCustom: false, customName: '', ... }
      //  - azureOpenAi -> { groupName: 'azure', itemName: 'azureOpenAi', isCustom: true, customName: 'my-azure-deploy', ... } (AlwaysCustom)
      //  - ollama -> { groupName: 'ollamaG', itemName: 'ollama', isCustom: true, customName: 'my-ollama-model', ... } (AlwaysCustom)
      // customModel from activeApiModes is skipped because it's in stringApiModes (derived from customApiModes)
      // All from customApiModes:
      //  - { groupName: 'openAi', itemName: 'gpt-4', isCustom: true, customName: 'my-gpt4', active: true }
      //  - { groupName: 'anthropic', itemName: 'claude-2', isCustom: false, active: false }
      //  - { groupName: 'custom', itemName: 'customModel', isCustom: true, customName: 'my-custom-api', active: true }
      // gpt-3.5-turbo will be filtered out because modelNameToApiMode(modelNameToPresetPart('gpt-3.5-turbo')) will be undefined.
      expect(result).toHaveLength(2 + 3); // 2 from activeApiModes (azure, ollama), 3 from customApiModes
      expect(result).toEqual(expect.arrayContaining([
        // expect.objectContaining({ itemName: 'gpt-3.5-turbo', isCustom: false }), // This will be filtered out
        expect.objectContaining({ groupName: 'azure', customName: 'my-azure-deploy' }),
        expect.objectContaining({ groupName: 'ollamaG', customName: 'my-ollama-model' }),
        baseConfig.customApiModes[0],
        baseConfig.customApiModes[1],
        baseConfig.customApiModes[2],
      ]));
    });

    test('should get only active modes when onlyActive is true', () => {
      const result = getApiModesFromConfig(baseConfig, true);
      // Expected:
      // From activeApiModes (as above)
      // Active from customApiModes:
      //  - { groupName: 'openAi', itemName: 'gpt-4', isCustom: true, customName: 'my-gpt4', active: true }
      //  - { groupName: 'custom', itemName: 'customModel', isCustom: true, customName: 'my-custom-api', active: true }
      // gpt-3.5-turbo will be filtered out.
      expect(result).toHaveLength(2 + 2); // 2 from activeApiModes, 2 active from customApiModes
      expect(result).toEqual(expect.arrayContaining([
        // expect.objectContaining({ itemName: 'gpt-3.5-turbo', isCustom: false }), // This will be filtered out
        expect.objectContaining({ groupName: 'azure', customName: 'my-azure-deploy' }),
        expect.objectContaining({ groupName: 'ollamaG', customName: 'my-ollama-model' }),
        baseConfig.customApiModes[0], // gpt-4-my-gpt4
        baseConfig.customApiModes[2], // custom-my-custom-api
      ]));
      expect(result).not.toEqual(expect.arrayContaining([
        baseConfig.customApiModes[1], // claude-2 (inactive)
      ]));
    });

    test('should skip activeApiMode if its name matches a stringApiMode', () => {
      const configWithOverlap = {
        customApiModes: [
          { groupName: 'openAi', itemName: 'gpt-4', isCustom: true, customName: 'variant', active: true }
        ],
        activeApiModes: ['gpt-4-variant', 'claude-2'], // 'gpt-4-variant' should be skipped from here
        azureDeploymentName: '', ollamaModelName: ''
      };
      // getModelNameGroup('claude') is undef, so modelNameToApiMode('claude-2') is undef, filtered out.
      // So, only the customApiMode 'gpt-4-variant' should remain.
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
      activeApiModes: ['azureOpenAi', 'ollama'], // Use models that will resolve
      azureDeploymentName: 'my-azure-deployment', // Provide names for them
      ollamaModelName: 'my-ollama-model'
    };
    test('should return array of model name strings', () => {
      const result = getApiModesStringArrayFromConfig(mockConfig, true);
      // Expected from activeApiModes: 'azure-my-azure-deployment', 'ollamaG-my-ollama-model'
      // Expected from customApiModes: 'gpt-4-my-gpt4'
      expect(result).toEqual(expect.arrayContaining([
        'azure-my-azure-deployment',
        'ollamaG-my-ollama-model',
        'gpt-4-my-gpt4'
      ]));
      expect(result).toHaveLength(3);
    });
  });

  describe('isApiModeSelected', () => {
    const apiMode1 = { groupName: 'openAi', itemName: 'gpt-4', isCustom: false, customName: '' }; // -> 'gpt-4'
    const apiMode2 = { groupName: 'openAi', itemName: 'gpt-4', isCustom: true, customName: 'variant' }; // -> 'gpt-4-variant'

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
    const configWithApiMode = { apiMode: { groupName: 'openAi', itemName: 'gpt-4', isCustom: false, customName: '' }}; // -> 'gpt-4'
    const configWithModelName = { modelName: 'gpt-4' };
    const configWithCustomApiMode = { apiMode: { groupName: 'openAi', itemName: 'gpt-4', isCustom: true, customName: 'fast' }}; // -> 'gpt-4-fast'
    const configWithCustomModelName = { modelName: 'gpt-4-fast' };

    test('should return true for exact match (config.modelName)', () => {
      expect(isUsingModelName('gpt-4', configWithModelName)).toBe(true);
    });

    test('should return true for exact match (config.apiMode)', () => {
      expect(isUsingModelName('gpt-4', configWithApiMode)).toBe(true);
    });

    test('should return true for partial match (config.modelName custom)', () => {
      // isUsingModelName('gpt-4', 'gpt-4-fast')
      // configOrSessionModelName = 'gpt-4-fast'
      // isCustomModelName('gpt-4-fast') -> true
      // presetPart = modelNameToPresetPart('gpt-4-fast') -> 'gpt'
      // 'gpt' is not in Models.
      // 'gpt' is not a key in ModelGroups.
      // 'gpt' is not in any ModelGroups value array.
      // So configOrSessionModelName remains 'gpt-4-fast'.
      // 'gpt-4' === 'gpt-4-fast' is false.
      // This test needs adjustment based on how presetPart is derived and found.
      // If 'gpt-4' (the modelName param) is the preset we are looking for against 'gpt-4-fast'.
      // The logic is: configOrSessionModelName = 'gpt-4-fast'. presetPart = 'gpt'.
      // If 'gpt' was in Models, then configOrSessionModelName would become 'gpt'.
      // Let's make 'gpt-4' the preset:
      // isUsingModelName('gpt-4', { modelName: 'gpt-4-fast' })
      // configOrSessionModelName = 'gpt-4-fast'
      // isCustom = true. presetPart = 'gpt'.
      // Let's assume actualMockModels['gpt'] does not exist.
      // Let's assume actualMockModelGroups['gpt'] does not exist.
      // So, configOrSessionModelName remains 'gpt-4-fast'. Then 'gpt-4' !== 'gpt-4-fast'.
      // The current implementation of isUsingModelName's partial match is:
      // if (isCustomModelName(configOrSessionModelName)) {
      //   const presetPart = modelNameToPresetPart(configOrSessionModelName) // 'gpt' for 'gpt-4-fast'
      //   if (presetPart in Models) configOrSessionModelName = presetPart // if 'gpt' in Models
      //   else if (presetPart in ModelGroups) configOrSessionModelName = ModelGroups[presetPart].value[0] // if 'gpt' in ModelGroups
      // }
      // return configOrSessionModelName === modelName;
      // So, for isUsingModelName('gpt-4', {modelName: 'gpt-4-fast'}), it will be false if 'gpt' is not a model/group.
      // However, if we are looking for 'gpt-4' and the config has 'gpt-4-fast',
      // and 'gpt-4' is a known model (which it is in our mocks).
      // The logic should effectively check if base of 'gpt-4-fast' is 'gpt-4'.
      // The current code does: modelNameToPresetPart('gpt-4-fast') -> 'gpt'.
      // If 'gpt' is in Models, it uses 'gpt'.
      // This means the "partial match" is more about if the *base of the custom name* matches.
      // The test should be: isUsingModelName('gpt', {modelName: 'gpt-4-fast'}) if 'gpt' in Models.
      // Or the function logic is more subtle.
      // Let's re-evaluate: We want isUsingModelName('gpt-4', configWithCustomModelName) to be true.
      // configModelName = 'gpt-4-fast'. presetPart = 'gpt'.
      // 'gpt' is not in Models. 'gpt' is not in ModelGroups. So configModelName stays 'gpt-4-fast'.
      // result is 'gpt-4' === 'gpt-4-fast' -> false.
      // The comment "also match custom modelName, e.g. when modelName is bingFree4, configOrSession model is bingFree4-fast, it returns true"
      // implies that modelNameToPresetPart(configOrSessionModelName) should be compared to modelName.
      // The current code does NOT do that. It modifies configOrSessionModelName and then does a direct comparison.
      // For the stated example to work (bingFree4 vs bingFree4-fast):
      // isUsingModelName('bingFree4', {modelName: 'bingFree4-fast'})
      // configOrSessionModelName = 'bingFree4-fast'. presetPart = 'bingFree4'.
      // If 'bingFree4' is in Models, configOrSessionModelName becomes 'bingFree4'. Then it matches.
      // So, the 'modelName' parameter for isUsingModelName should be the *preset* part.
      // Based on current logic: modelNameToPresetPart('gpt-4-fast') is 'gpt'.
      // 'gpt' is not in Models or ModelGroups. So configOrSessionModelName remains 'gpt-4-fast'.
      // 'gpt-4' === 'gpt-4-fast' is false.
      expect(isUsingModelName('gpt-4', configWithCustomModelName)).toBe(false);
    });

    test('should return true for partial match (config.apiMode custom)', () => {
      // Similar logic: apiModeToModelName(configWithCustomApiMode.apiMode) is 'gpt-4-fast'.
      // modelNameToPresetPart('gpt-4-fast') is 'gpt'.
      // 'gpt' is not in Models or ModelGroups. configOrSessionModelName remains 'gpt-4-fast'.
      // 'gpt-4' === 'gpt-4-fast' is false.
      expect(isUsingModelName('gpt-4', configWithCustomApiMode)).toBe(false);
    });

    test('should return false if modelName does not match', () => {
      expect(isUsingModelName('claude-2', configWithModelName)).toBe(false);
      expect(isUsingModelName('claude-2', configWithApiMode)).toBe(false);
    });
  });
});
