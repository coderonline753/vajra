/**
 * Vajra Saga Orchestration
 * Declarative multi-step transactions with automatic compensation on failure.
 */

export interface SagaStep<TContext = Record<string, unknown>> {
  name: string;
  execute: (context: TContext) => Promise<TContext>;
  compensate: (context: TContext) => Promise<void>;
}

export type SagaStatus = 'pending' | 'running' | 'completed' | 'failed' | 'compensating' | 'compensated';

interface SagaResult<TContext> {
  status: SagaStatus;
  context: TContext;
  completedSteps: string[];
  failedStep?: string;
  error?: string;
  compensatedSteps: string[];
  duration: number;
}

interface SagaOptions {
  onStepComplete?: (step: string, context: unknown) => void;
  onStepFailed?: (step: string, error: Error) => void;
  onCompensate?: (step: string) => void;
}

export class Saga<TContext extends Record<string, unknown> = Record<string, unknown>> {
  readonly name: string;
  private steps: SagaStep<TContext>[] = [];
  private options: SagaOptions;

  constructor(name: string, options: SagaOptions = {}) {
    this.name = name;
    this.options = options;
  }

  /** Add a step to the saga */
  step(
    name: string,
    execute: SagaStep<TContext>['execute'],
    compensate: SagaStep<TContext>['compensate']
  ): this {
    this.steps.push({ name, execute, compensate });
    return this;
  }

  /** Execute the saga */
  async run(initialContext: TContext): Promise<SagaResult<TContext>> {
    const startTime = performance.now();
    let context = { ...initialContext };
    const completedSteps: string[] = [];
    const compensatedSteps: string[] = [];

    for (const step of this.steps) {
      try {
        context = await step.execute(context);
        completedSteps.push(step.name);
        this.options.onStepComplete?.(step.name, context);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.options.onStepFailed?.(step.name, error);

        // Compensate completed steps in reverse order
        for (let i = completedSteps.length - 1; i >= 0; i--) {
          const compensateStep = this.steps.find(s => s.name === completedSteps[i])!;
          try {
            this.options.onCompensate?.(compensateStep.name);
            await compensateStep.compensate(context);
            compensatedSteps.push(compensateStep.name);
          } catch (compErr) {
            console.error(`[Saga] Compensation failed for step '${compensateStep.name}':`, compErr);
          }
        }

        return {
          status: 'compensated',
          context,
          completedSteps,
          failedStep: step.name,
          error: error.message,
          compensatedSteps,
          duration: Math.round((performance.now() - startTime) * 100) / 100,
        };
      }
    }

    return {
      status: 'completed',
      context,
      completedSteps,
      compensatedSteps: [],
      duration: Math.round((performance.now() - startTime) * 100) / 100,
    };
  }
}
