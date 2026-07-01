export async function executeCode(code, language = 'javascript') {
  try {
    if (language === 'javascript') {
      const result = await new Promise((resolve, reject) => {
        try {
          const func = new Function(code);
          const output = func();
          resolve({ success: true, output: output });
        } catch (error) {
          resolve({ success: false, error: error.message });
        }
      });
      return result;
    } else if (language === 'python') {
      return { 
        success: false, 
        error: 'Python execution not supported in this environment. Use JavaScript instead.' 
      };
    } else {
      return { success: false, error: `Unsupported language: ${language}` };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}