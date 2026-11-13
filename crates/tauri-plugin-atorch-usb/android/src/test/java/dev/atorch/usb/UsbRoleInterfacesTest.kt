package dev.atorch.usb

import org.junit.Assert.*
import org.junit.Test

class UsbRoleInterfacesTest {
    @Test fun selectsTheDiscoveredControllerWithoutAModelOrFixedAddress() {
        val path = "/sys/class/usb_role/test-controller-role-switch/role"
        val selected = UsbRoleInterfaces.select("$path\tnone\t1\n")
        assertEquals(path, selected.path)
        assertEquals("none", selected.role)
        assertTrue(selected.writable)
    }
    @Test fun refusesAmbiguousControllers() {
        val output = "/sys/class/usb_role/usb0/role\tnone\t1\n/sys/class/usb_role/usb1/role\tnone\t1"
        val error = assertThrows(IllegalStateException::class.java) { UsbRoleInterfaces.select(output) }
        assertTrue(error.message!!.contains("多个"))
    }
    @Test fun reportsAnAbsentInterface() {
        val error = assertThrows(IllegalStateException::class.java) { UsbRoleInterfaces.select("\n") }
        assertTrue(error.message!!.contains("未找到"))
    }
    @Test fun refusesAnUnwritableInterface() {
        val output = "/sys/class/usb_role/usb0/role\tnone\t0"
        val error = assertThrows(IllegalStateException::class.java) { UsbRoleInterfaces.select(output) }
        assertTrue(error.message!!.contains("不可写"))
    }
    @Test fun invalidPathsAndRolesCannotReachTheWriter() {
        listOf(
            "/sys/class/usb_role/../role\tnone\t1",
            "/sys/class/usb_role/usb0/role;id\tnone\t1",
            "/sys/class/typec/port0/data_role\tnone\t1",
            "/sys/class/usb_role/usb0/role\tunknown\t1",
        ).forEach { output ->
            assertThrows(IllegalStateException::class.java) { UsbRoleInterfaces.select(output) }
        }
    }
    @Test fun recoveryUsesTheSavedControllerAndSupportsLegacyRecords() {
        val recorded = "/sys/class/usb_role/other-controller/role"
        assertEquals(recorded, UsbRoleInterfaces.restorePath(recorded))
        assertEquals(UsbRoleInterfaces.LEGACY_ROLE_PATH, UsbRoleInterfaces.restorePath(null))
        assertThrows(IllegalStateException::class.java) { UsbRoleInterfaces.restorePath("/data/local/tmp/role") }
    }
}
