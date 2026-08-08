import { runSandboxedTask } from '../core/sandbox';
import { ENV } from '../config/env.config';

const testMatrix = [
    {
        name: "1. Fibonacci",
        objective: "compute the 20th Fibonacci number"
    },
    {
        name: "2. Stats (tempts numpy)",
        objective: "given the list [4, 8, 15, 16, 23, 42], return the mean, median, and standard deviation"
    },
    {
        name: "3. CSV (tempts pandas)",
        objective: "parse this CSV data and print the average of the 'price' column",
        inputData: "id,name,price\n1,apple,1.50\n2,banana,0.75\n3,orange,2.25"
    },
    {
        name: "4. String manipulation",
        objective: "reverse the string 'push to prod' and count the vowels in it"
    },
    {
        name: "5. Structured input sorting",
        objective: "sort this list of dictionaries by the 'age' key: [{'name':'a','age':30},{'name':'b','age':22}]"
    },
    {
        name: "6. ASCII Chart (tempts matplotlib)",
        objective: "generate a simple ASCII bar chart from the list [3, 7, 2, 9, 4]"
    },
    {
        name: "7. Impossible (network access)",
        objective: "access the internet and fetch today's date from an external API"
    }
];

async function runTests() {
    console.log("=== Sandbox Standalone Tests ===");
    console.log(`Using GEMINI_API_KEY: ${!!ENV.GEMINI_API_KEY}`);
    console.log(`Using ANTHROPIC_API_KEY: ${!!ENV.ANTHROPIC_API_KEY}`);
    
    let passCount = 0;

    for (const test of testMatrix) {
        console.log(`\n--- Running Test: ${test.name} ---`);
        try {
            const result = await runSandboxedTask(test.objective, 'python', test.inputData);
            console.log(`Success: ${result.success}`);
            console.log(`Attempts: ${result.attempts.length}`);
            console.log(`Final Output:\n${result.finalOutput}`);
            
            if (result.success) {
                passCount++;
            }
        } catch (e: any) {
            console.error(`Test failed with exception: ${e.message}`);
        }
    }

    console.log(`\n=== Test Summary: ${passCount}/${testMatrix.length} Passed ===`);
}

runTests().catch(console.error);
