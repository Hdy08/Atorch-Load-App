package dev.atorch.usb

import org.junit.Assert.*
import org.junit.Test

class RootUsbSessionTest {
    private class Journal : UsbRoleJournal {
        var saved: String? = null
        override fun original() = saved
        override fun save(role: String) { saved = role }
        override fun clear() { saved = null }
    }
    private class Roles(private val journal: Journal) : UsbRoleAccess {
        var role = "none"
        var reads = 0
        val writes = mutableListOf<String>()
        var denied = false
        var hostFailure = false
        var restoreFailure = false
        override fun read(): String {
            reads++
            check(!denied) { "Root denied" }
            return role
        }
        override fun write(role: String) {
            assertNotNull("Journal must be durable before changing the port", journal.saved)
            writes.add(role)
            if (role == "none" && restoreFailure) error("Restore denied")
            this.role = role
            if (role == "host" && hostFailure) error("Host verification failed")
        }
    }

    @Test fun defaultAndStatusDoNotRequestRoot() {
        val journal = Journal(); val roles = Roles(journal)
        val session = RootUsbSession(true, roles, journal)
        assertFalse(session.status().enabled)
        assertFalse(session.status().restorePending)
        assertEquals(0, roles.reads)
        assertTrue(roles.writes.isEmpty())
    }
    @Test fun disconnectRestoresOnlyTheOwnedRole() {
        val journal = Journal(); val roles = Roles(journal)
        val session = RootUsbSession(true, roles, journal)
        session.enable()
        assertTrue(session.status().enabled)
        assertEquals("none", journal.saved)
        session.restoreIfOwned()
        assertEquals(listOf("host", "none"), roles.writes)
        assertEquals("none", roles.role)
        assertNull(journal.saved)
        session.restoreIfOwned()
        assertEquals(2, roles.writes.size)
    }
    @Test fun existingUsbSessionIsNotTakenOver() {
        val journal = Journal(); val roles = Roles(journal); roles.role = "device"
        val session = RootUsbSession(true, roles, journal)
        assertThrows(IllegalStateException::class.java) { session.enable() }
        assertTrue(roles.writes.isEmpty())
        assertNull(journal.saved)
    }
    @Test fun deniedRootDoesNotLeaveAnEnabledSwitchOrJournal() {
        val journal = Journal(); val roles = Roles(journal); roles.denied = true
        val session = RootUsbSession(true, roles, journal)
        assertThrows(IllegalStateException::class.java) { session.enable() }
        assertFalse(session.status().enabled)
        assertFalse(session.status().restorePending)
        assertNotNull(session.status().error)
        assertTrue(roles.writes.isEmpty())
    }
    @Test fun failedSwitchRollsBackEvenIfTheWriteTookEffect() {
        val journal = Journal(); val roles = Roles(journal); roles.hostFailure = true
        val session = RootUsbSession(true, roles, journal)
        assertThrows(IllegalStateException::class.java) { session.enable() }
        assertEquals("none", roles.role)
        assertNull(journal.saved)
        assertFalse(session.status().enabled)
    }
    @Test fun failedRestoreKeepsRecoveryRecordAcrossProcessRestart() {
        val journal = Journal(); val roles = Roles(journal)
        val session = RootUsbSession(true, roles, journal)
        session.enable(); roles.restoreFailure = true
        assertThrows(IllegalStateException::class.java) { session.restoreIfOwned() }
        assertTrue(session.status().restorePending)
        val restarted = RootUsbSession(true, roles, journal)
        assertFalse(restarted.status().enabled)
        assertTrue(restarted.status().restorePending)
        val reads = roles.reads
        restarted.status()
        assertEquals(reads, roles.reads)
        roles.restoreFailure = false
        restarted.restore()
        assertEquals("none", roles.role)
        assertFalse(restarted.status().restorePending)
        assertNull(journal.saved)
    }
    @Test fun missingUsbHostSupportNeverExecutesRoot() {
        val journal = Journal(); val roles = Roles(journal)
        val session = RootUsbSession(false, roles, journal)
        assertThrows(IllegalStateException::class.java) { session.enable() }
        assertEquals(0, roles.reads)
        assertTrue(roles.writes.isEmpty())
    }
}
