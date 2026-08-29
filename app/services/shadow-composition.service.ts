import {
    ShadowObservationStore,
    ShadowRunner,
    ShadowVirtualExecutionPort
} from '../paper/shadow-runner';
import { SequelizeShadowObservationRepository } from './sequelize-shadow-observation.repository';
import { SequelizeVirtualExecutionRepository } from './sequelize-virtual-execution.repository';

/**
 * Construction is intentionally hard-disabled. Runtime activation requires a
 * separate reviewed composition change and must not be inferred from config.
 */
export const createDisabledShadowRunner = (
    observations: ShadowObservationStore = new SequelizeShadowObservationRepository(),
    execution: ShadowVirtualExecutionPort = new SequelizeVirtualExecutionRepository()
) => new ShadowRunner(
    false,
    observations,
    execution
);
